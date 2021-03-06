// One-off admin process to apply actions to specific files, e.g.
// -- delete grib2-files in rotated coordinates
// -- move oldest files to separate harddisk in order to gain space
// SPDX-License-Identifier: MIT

'use strict'

const _ = require('lodash')
const fs = require('fs-extra')
const path = require('path')
const processenv = require('processenv')
const bunyan = require('bunyan')
const moment = require('moment')

// Load configuration
const DOWNLOAD_DIRECTORY_BASE_PATH = processenv('DOWNLOAD_DIRECTORY_BASE_PATH')
const NEW_DIRECTORY_BASE_PATH = processenv('NEW_DIRECTORY_BASE_PATH')
const CRITERION = processenv('CRITERION')
const THRESHOLD = processenv('THRESHOLD')

// Instantiate logger
let log = bunyan.createLogger({
  name: 'act_on_specific_files.js',
  level: 'debug'
})
log.info('entering admin script `act_on_specific_files.js`')

// Define validity of inputs
async function checkIfConfigIsValid () {
  if (_.isNil(DOWNLOAD_DIRECTORY_BASE_PATH)) {
    log.fatal('FATAL: environment variable DOWNLOAD_DIRECTORY_BASE_PATH missing')
    process.exit(1)
  } else if (!(await fs.pathExists(DOWNLOAD_DIRECTORY_BASE_PATH))) {
    log.fatal('FATAL: DOWNLOAD_DIRECTORY_BASE_PATH is given but does not exist')
    process.exit(1)
  } else if (_.isNil(NEW_DIRECTORY_BASE_PATH)) {
    log.fatal('FATAL: environment variable NEW_DIRECTORY_BASE_PATH missing')
    process.exit(1)
  } else if (!(await fs.pathExists(NEW_DIRECTORY_BASE_PATH))) {
    log.fatal('FATAL: NEW_DIRECTORY_BASE_PATH is given but does not exist')
    process.exit(1)
  } else if ((_.isNil(CRITERION))  || !(CRITERION === 'rotated' || CRITERION === 'oldest')) {
    log.fatal('FATAL: environment variable CRITERION missing or is not set to "rotated" or "oldest"')
    process.exit(1)
  } else if (!_.isString(THRESHOLD)) {
    log.fatal('FATAL: environment variable THRESHOLD missing or not a string')
    process.exit(1)
  } else {
    log.info('DOWNLOAD_DIRECTORY_BASE_PATH is set to', DOWNLOAD_DIRECTORY_BASE_PATH)
    log.info('NEW_DIRECTORY_BASE_PATH is set to', NEW_DIRECTORY_BASE_PATH)
    log.info('CRITERION is set to', CRITERION)
    log.info('THRESHOLD is set to', THRESHOLD)
    log.info('configuration is valid, moving on...')
  }
}

// Define functions
async function applyActionToAllFilesMatchingCriteria(basePath, criterion, action) {
  log.debug(`traversing directory ${basePath}`)
  let numberOfFilesActedOn = 0

  let dirContents = null
  try {
    dirContents = await fs.readdir(basePath)
  } catch (error) {
    log.error(error)
    return
  }

  for (let item of dirContents) {
    const itemPath = path.join(basePath, item)
    const itemProperties = await fs.stat(itemPath)

    if (itemProperties.isDirectory()) {
      numberOfFilesActedOn += await applyActionToAllFilesMatchingCriteria(
        itemPath,
        criterion,
        action
      )
    } else {
      if (await criterion(itemPath)) {
        try {
          await action(itemPath)
        } catch (error) {
          log.error(error)
          continue
        }
        numberOfFilesActedOn += 1
      }
    }
  }
  return numberOfFilesActedOn
}

// Definition of functions to evaluate criteria
async function createdBeforeDate (filePath, dateStringIso8601) {
  const stats = await fs.stat(filePath)
  const fileBirthTime = moment(stats.birthtimeMs).utc()
  const threshold = moment(dateStringIso8601).utc()

  return moment(fileBirthTime).isBefore(threshold)
}

async function filePathHasDateBefore (filePath, dateStringIso8601) {
  const regex = /^201[8-9]{1}[0-1]{1}[0-9]{3,5}$/
  const threshold = moment(dateStringIso8601).utc()
  const filePathParts = _.split(filePath, path.sep)
  const forecastRun = String(_.find(filePathParts, function (part) {
    return part.match(regex)
  }))
  let forecastRunAsObject = null
  if (forecastRun.length === 8) {
    forecastRunAsObject = moment(forecastRun).utc()
  } else if (forecastRun.length === 10) {
    forecastRunAsObject = moment(forecastRun, 'YYYYMMDDHH').utc()
  }

  return moment(forecastRunAsObject).isBefore(threshold)
}

// Definition of actions
async function moveToNewBasedirKeepSubdirs (filePathOld, basePathOld, basePathNew) {
  const filePathNew = await _.replace(
    filePathOld,
    basePathOld,
    basePathNew
  )

  try {
    await fs.move(filePathOld, filePathNew)
    log.debug(`moved ${filePathOld} to ${filePathNew}`)
  } catch (error) {
    log.error(error)
  }
}

async function moveAllRotatedGrib2Files (basePathOld, basePathNew) {
  // Find all grib2-files that have 'rotated' as part of their filename
  // and have a 'regular' sibling, then replace its basePath/move it
  let numberOfFilesMoved = 0

  try {
    const subDirs = await fs.readdir(basePathOld)
    for (const subDir of subDirs) {
      const subDirPath = path.join(basePathOld, subDir)

      const subSubDirs = await fs.readdir(subDirPath)
      for (const subSubDir of subSubDirs) {
        const subSubDirPath = path.join(subDirPath, subSubDir)

        const files = await fs.readdir(subSubDirPath)
        for (const file of files) {
          // Iff there is a 'regular' version,  mark the 'rotated' one for removal
          const filePath = path.join(subSubDirPath, file)
          if (
            (_.includes(file, 'rotated') === true) &&
            (_.endsWith(file, 'grib2.lz4'))
          ) {
            const sibling = await _.replace(file, 'rotated', 'regular')
            const fileHasSibling = await fs.pathExists(
              path.join(subSubDirPath, sibling)
            )
            if (fileHasSibling === true) {
              log.debug(`file ${file} has sibling ${sibling}`)

              // Move the rotated file to a separate directory
              const filePathOld = filePath
              const filePathNew = await _.replace(
                filePathOld,
                basePathOld,
                basePathNew
              )

              try {
                await fs.move(filePathOld, filePathNew)
                numberOfFilesMoved += 1

                log.debug(`moved ${filePathOld} to ${filePathNew}`)
              } catch (error) {
                log.warn(error)
              }
            }
          }
        }
        log.debug(`analyzed ${files.length} files in ./${subDir}/${subSubDir}`)
      }
      log.info(`analyzed files in ./${subDir}`)
    }
  } catch (error) {
    log.fatal(error)
    process.exit(1)
  }
  return numberOfFilesMoved
}

// Define main function
const main = async function () {
  await checkIfConfigIsValid()

  let totalFilesMoved = 0

  // Select criteria for identifying relevant files
  log.info(`attempting to apply action to files according to CRITERION '${CRITERION}'`)
  switch (CRITERION) {
    case 'rotated':
      const gribFilesBasePath = path.join(
        DOWNLOAD_DIRECTORY_BASE_PATH,
        'weather',
        'cosmo-d2',
        'grib'
      )
      const gribFilesBasePathExists = await fs.pathExists(gribFilesBasePath)

      const rotatedFilesBasePath = path.join(
        NEW_DIRECTORY_BASE_PATH,
        'cosmo-d2',
        'grib'
      )

      if (gribFilesBasePathExists) {
        try {
          await fs.ensureDir(rotatedFilesBasePath)
          totalFilesMoved = await moveAllRotatedGrib2Files(gribFilesBasePath, rotatedFilesBasePath)
        } catch (error) {
          log.fatal(error)
          process.exit(1)
        }
      }
      break
    case 'oldest':
      const olderThanEnvvarThreshold = async (filePath) => {
        let result
        try {
          result = await filePathHasDateBefore(filePath, THRESHOLD)
        } catch (error) {
          throw error
        }
        return result
      }

      const moveFilesAway = async (filePath) => {
        let result
        try {
          result = await moveToNewBasedirKeepSubdirs(
            filePath,
            DOWNLOAD_DIRECTORY_BASE_PATH,
            NEW_DIRECTORY_BASE_PATH
          )
        } catch (error) {
          throw error
        }
        return result
      }

      totalFilesMoved = await applyActionToAllFilesMatchingCriteria(
        DOWNLOAD_DIRECTORY_BASE_PATH,
        olderThanEnvvarThreshold,
        moveFilesAway
      )
      break
  }
  log.info(`successfully moved ${totalFilesMoved} files!`)
}

// Execute as independent script
if (require.main === module) {
  main()
}
