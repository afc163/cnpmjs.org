/**!
 * cnpmjs.org - controllers/registry/package/list.js
 *
 * Copyright(c) fengmk2 and other contributors.
 * MIT Licensed
 *
 * Authors:
 *   fengmk2 <fengmk2@gmail.com> (http://fengmk2.github.com)
 */

'use strict';

/**
 * Module dependencies.
 */

var debug = require('debug')('cnpmjs.org:controllers:registry:package:list');
var packageService = require('../../../services/package');
var npmService = require('../../../services/npm');
var config = require('../../../config');
var setDownloadURL = require('../../../lib/common').setDownloadURL;
var SyncModuleWorker = require('../../sync_module_worker');

/**
 * list all version of a module
 * GET /:name
 */
module.exports = function* list() {
  var orginalName = this.params.name || this.params[0];
  var name = orginalName;
  var rs = yield [
    packageService.getModuleLastModified(name),
    packageService.listModuleTags(name)
  ];
  var modifiedTime = rs[0];
  var tags = rs[1];

  debug('show %s(%s), last modified: %s, tags: %j', name, orginalName, modifiedTime, tags);
  if (modifiedTime) {
    // find out the latest modfied time
    // because update tags only modfied tag, wont change module gmt_modified
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      if (tag.gmt_modified > modifiedTime) {
        modifiedTime = tag.gmt_modified;
      }
    }

    // use modifiedTime as etag
    this.set('ETag', '"' + modifiedTime.getTime() + '"');

    // must set status first
    this.status = 200;
    if (this.fresh) {
      debug('%s not change at %s, 304 return', name, modifiedTime);
      this.status = 304;
      return;
    }
  }

  var r = yield [
    packageService.listModulesByName(name),
    packageService.listStarUserNames(name),
    packageService.listMaintainers(name),
  ];
  var rows = r[0];
  var starUsers = r[1];
  var maintainers = r[2];

  debug('show %s got %d rows, %d tags, %d star users, maintainers: %j',
    name, rows.length, tags.length, starUsers.length, maintainers);

  var starUserMap = {};
  for (var i = 0; i < starUsers.length; i++) {
    starUserMap[starUsers[i]] = true;
  }
  starUsers = starUserMap;

  if (rows.length === 0) {
    // check if unpublished
    var unpublishedInfo = yield* packageService.getUnpublishedModule(name);
    debug('show unpublished %j', unpublishedInfo);
    if (unpublishedInfo) {
      this.status = 404;
      this.body = {
        _id: orginalName,
        name: orginalName,
        time: {
          modified: unpublishedInfo.package.time,
          unpublished: unpublishedInfo.package,
        },
        _attachments: {}
      };
      return;
    }
  }

  // if module not exist in this registry,
  // sync the module backend and return package info from official registry
  if (rows.length === 0) {
    if (!this.allowSync) {
      this.status = 404;
      this.body = {
        error: 'not_found',
        reason: 'document not found'
      };
      return;
    }

    // start sync
    var logId = yield* SyncModuleWorker.sync(name, 'sync-by-install');
    debug('start sync %s, get log id %s', name, logId);

    // try to get package from official registry
    var r = yield* npmService.request('/' + name, {
      registry: config.officialNpmRegistry
    });

    debug('requet from officialNpmRegistry response %s', r.status);
    if (r.status !== 200) {
      this.status = 404;
      this.body = {
        error: 'not_found',
        reason: 'document not found'
      };
      return;
    }

    this.body = r.data;
    return;
  }

  var latestMod = null;
  var readme = null;
  // set tags
  var distTags = {};
  for (var i = 0; i < tags.length; i++) {
    var t = tags[i];
    distTags[t.tag] = t.version;
  }

  // set versions and times
  var versions = {};
  var times = {};
  var attachments = {};
  var createdTime = null;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var pkg = row.package;
    setDownloadURL(pkg, this);
    pkg._cnpm_publish_time = row.publish_time;
    versions[pkg.version] = pkg;

    var t = times[pkg.version] = row.publish_time ? new Date(row.publish_time) : row.gmt_modified;
    if ((!distTags.latest && !latestMod) || distTags.latest === pkg.version) {
      latestMod = row;
      readme = pkg.readme;
    }

    delete pkg.readme;
    if (maintainers.length > 0) {
      pkg.maintainers = maintainers;
    }

    if (!createdTime || t < createdTime) {
      createdTime = t;
    }
  }

  if (modifiedTime && createdTime) {
    var ts = {
      modified: modifiedTime,
      created: createdTime,
    };
    for (var t in times) {
      ts[t] = times[t];
    }
    times = ts;
  }

  if (!latestMod) {
    latestMod = rows[0];
  }

  var rev = String(latestMod.id);
  var pkg = latestMod.package;

  if (tags.length === 0) {
    // some sync error reason, will cause tags missing
    // set latest tag at least
    distTags.latest = pkg.version;
  }

  var info = {
    _id: orginalName,
    _rev: rev,
    name: orginalName,
    description: pkg.description,
    "dist-tags": distTags,
    maintainers: pkg.maintainers,
    time: times,
    users: starUsers,
    author: pkg.author,
    repository: pkg.repository,
    versions: versions,
    readme: readme,
    _attachments: attachments,
  };

  info.readmeFilename = pkg.readmeFilename;
  info.homepage = pkg.homepage;
  info.bugs = pkg.bugs;
  info.license = pkg.license;

  debug('show module %s: %s, latest: %s', orginalName, rev, latestMod.version);
  this.body = info;
};
