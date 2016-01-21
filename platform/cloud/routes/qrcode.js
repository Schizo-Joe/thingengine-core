// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2015 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details

var Q = require('q');
var express = require('express');

var router = express.Router();

router.get('/qrcode/:server/:port/:auth_token', function(req, res, next) {
    res.render('qrcode', { for_: 'server',
                           link: req.originalUrl,
                           authToken: req.params.auth_token });
});

router.get('/qrcode-cloud/:cloud_id/:auth_token', function(req, res, next) {
    res.render('qrcode', { for_: 'cloud',
                           link: req.originalUrl,
                           authToken: req.params.auth_token,
                           cloudId: req.params.cloud_id });
});

router.get('/qrcode-thingpedia/install/:thingpedia_id', function(req, res, next) {
    res.render('qrcode', { for_: 'thingpedia',
                           thingpediaId: req.params.thingpedia_id });
});

module.exports = router;