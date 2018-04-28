// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2017 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const stream = require('stream');
const ThingTalk = require('thingtalk');

const Protocol = require('../tiers/protocol');
const ArraySet = require('../util/array_set');
const ChannelStateBinder = require('../db/channel');

const CURRENT_VERSION = 3;

const Message = {
    INSTALL: 'i',
    ABORT: 'a',
    DATA: 'd',
    END: 'e',
    JOIN: 'j',
    GET_TABLE_SCHEMA: 'tg',
    TABLE_SCHEMA_REPLY: 'tr'
};

class Subscription extends stream.Readable {
    constructor(messaging, flowId, state, sharedState) {
        super({ objectMode: true });

        this.principal = null;
        this._messaging = messaging;
        this._flowId = flowId;
        this.sharedState = sharedState;
        this.state = state;
        this._joinTimeout = sharedState.get('join-timeout');
        this._endTimeout = null;

        if (!state['members'])
            state['members'] = [];
        this._members = new ArraySet(state['members']);
        if (!state['member-ended'])
            state['member-ended'] = [];
        this._memberEnded = new ArraySet(state['member-ended']);

        if (state['all-ended']) {
            console.log(`Subscription for ${this._flowId} was already ended`);
            setImmediate(() => this.push(null));
        }
    }

    _read() {
        // nothing to do
    }

    _checkJoinAllowed(user) {
        if (this.principal === null) {
            console.error(`join message for ${user} processed before the subscription was ready`);
            return Promise.resolve(false);
        }

        if (Array.isArray(this.principal))
            return Promise.resolve(this.principal.indexOf(user) >= 0);

        return this._messaging.getFeedByAlias(this.principal).then((feed) => {
            return feed.getMembers().indexOf(user) >= 0;
        });
    }

    processJoin(user) {
        this._checkJoinAllowed(user).then((isAllowed) => {
            if (!isAllowed) {
                console.log(`join for ${user} in ${this._flowId} not allowed`);
                return Promise.resolve();
            }

            if (this._members.add(user)) {
                this.sharedState.changed();
                return this.sharedState.flushToDisk();
            }

            return Promise.resolve();
        }).catch((e) => {
            console.error(`Failed to process join from user ${user} in flow ${this._flowId}`, e);
        });
    }

    processData(user, data) {
        if (this.state['all-ended'])
            return;
        if (!this._members.has(user)) {
            console.log('??? data message before join! from user ' + user);
            return;
        }
        this.push(data);
    }

    processEnd(user) {
        if (this.state['all-ended'])
            return;
        if (!this._members.has(user)) {
            console.log('??? end message before join! from user ' + user);
            return;
        }
        this._memberEnded.add(user);
        this._checkEnded();
    }

    processAbort(user) {
        if (this.state['all-ended'])
            return;
        if (this._members.delete(user)) {
            this._memberEnded.delete(user);
            this._checkEnded();
        }
    }

    _checkEnded() {
        this.sharedState.changed();
        if (this._members.size !== this._memberEnded.size)
            return;
        let now = Date.now();
        if (now < this._joinTimeout) {
            console.log('Not processing end, still waiting for other people to join');
            if (!this._endTimeout)
                this._endTimeout = setTimeout(() => this._checkEnded(), this._joinTimeout - now);
            return;
        }

        console.log(`Subscription for flow ${this._flowId} ended`);

        this.state['all-ended'] = true;
        this.sharedState.flushToDisk().then(() => {
            this.push(null);
        }, (e) => {
            console.error('Failed to write subscription state to disk', e);
            // emit end without saving, and hope for the best
            this.push(null);
        });
    }
}

// wait 10s for VAs to join the program
const JOIN_TIMEOUT = 10000;

class SharedProgramState {
    constructor(platform, messaging, uniqueId) {
        this._platform = platform;
        this._messaging = messaging;

        this.state = null;
        this._uniqueId = uniqueId;
        this._subscriptions = new Map;
    }

    writeToDisk() {
        return this._ensureState().then((state) => state.flushToDisk());
    }

    _ensureSubscription(state, flowId) {
        if (this._subscriptions.has(flowId))
            return this._subscriptions.get(flowId);

        let substate = state.get('subscriptions')[flowId];
        if (!substate)
            substate = state.get('subscriptions')[flowId] = {};

        let sub = new Subscription(this._messaging, flowId, substate, state);
        this._subscriptions.set(flowId, sub);
        return sub;
    }

    subscribe(principal, flowId) {
        return this._ensureState().then((state) => {
            let sub = this._ensureSubscription(state, flowId);
            sub.principal = principal;
            return sub;
        });
    }

    processJoin(user) {
        this._ensureState().then((state) => {
            if (state.get('all-ended'))
                return;

            for (let sub of this._subscriptions.values())
                sub.processJoin(user);
        }).catch((e) => {
            console.error(`Failed to process join from ${user} to ${this._uniqueId}`, e);
        });
    }

    processAbort(user) {
        this._ensureState().then((state) => {
            if (state.get('all-ended'))
                return;

            for (let sub of this._subscriptions.values())
                sub.processAbort(user);
        }).catch((e) => {
            console.error(`Failed to process abort from ${user} to ${this._uniqueId}`, e);
        });
    }

    processData(user, flowId, data) {
        this._ensureState().then((state) => {
            if (state.get('all-ended'))
                return;

            let sub = this._ensureSubscription(state, flowId);
            sub.processData(user, data);
        }).catch((e) => {
            console.error(`Failed to process data from ${user} to ${this._uniqueId}`, e);
        });
    }

    processEnd(user, flowId) {
        this._ensureState().then((state) => {
            if (state.get('all-ended'))
                return;

            let sub = this._ensureSubscription(state, flowId);
            sub.processEnd(user);
        }).catch((e) => {
            console.error(`Failed to process end from ${user} to ${this._uniqueId}`, e);
        });
    }

    _ensureState() {
        if (this.state)
            return Promise.resolve(this.state);

        return this.state = new Promise((resolve, reject) => {
            let state = new ChannelStateBinder(this._platform);
            state.init('org.thingpedia.builtin.thingengine.remote-subscriptions-' + this._uniqueId);

            state.open().then(() => {
                if (!state.get('subscriptions'))
                    state.set('subscriptions', {});
                if (!state.get('join-timeout'))
                    state.set('join-timeout', Date.now() + JOIN_TIMEOUT);

                resolve(state);
            }, reject);
        });
    }
}

module.exports = class CommunicationManager {
    constructor(platform, executor, messaging, tierManager, devices, schemaRetriever) {
        this._platform = platform;
        this._executor = executor;
        this._messaging = messaging;
        this._tierManager = tierManager;
        this._devices = devices;
        this._schemaRetriever = schemaRetriever;

        this._incomingMessageListener = this._onIncomingMessage.bind(this);
        this._subscriptions = new Map;

        this._tableSchemaRequests = new Map;
        this._nextRPCId = 0;
    }

    _getSharedProgramState(uniqueId, create) {
        if (this._subscriptions.has(uniqueId)) {
            return this._subscriptions.get(uniqueId);
        } else if (create) {
            let state = new SharedProgramState(this._platform, this._messaging, uniqueId);
            this._subscriptions.set(uniqueId, state);
            console.log(`Created shared state for program ${uniqueId}`);
            return state;
        } else {
            console.log(`Cannot find shared state for program ${uniqueId}`);
            return null;
        }
    }

    _onIncomingMessage(feedId, message) {
        let parsed;
        try {
            switch (message.type) {
            case 'text':
                parsed = JSON.parse(message.text);
                break;
            case 'app':
                parsed = message.json;
                break;
            default:
                return;
            }
        } catch(e) {
            console.log('Failed parse incoming message as JSON: ' + e.message);
            return;
        }
        if (!parsed)
            return;

        if (parsed.v !== CURRENT_VERSION) {
            console.log('Invalid version');
            return;
        }
        switch (parsed.op) {
        case Message.ABORT:
            this._handleAbortProgram(feedId, message, parsed);
            break;
        case Message.INSTALL:
            this._handleInstallProgram(feedId, message, parsed);
            break;
        case Message.DATA:
            this._handleRemoteData(feedId, message, parsed);
            break;
        case Message.END:
            this._handleRemoteEnd(feedId, message, parsed);
            break;
        case Message.JOIN:
            this._handleRemoteJoin(feedId, message, parsed);
            break;
        case Message.TABLE_SCHEMA_REPLY:
            this._handleTableSchemaReply(feedId, message, parsed);
            break;
        case Message.GET_TABLE_SCHEMA:
            this._handleGetTableSchema(feedId, message, parsed);
            break;

        default:
            // other messages belong to other protocols/subsystems, ignore them
            //console.log('Unhandled op ' + parsed.op);
        }
    }

    _handleAbortProgram(feedId, message, parsed) {
        let uniqueId = parsed.uuid;
        let error = null;
        if (parsed.err) {
            error = new Error(parsed.err.m);
            error.code = parsed.err.c;
        }
        console.log(`${message.sender} aborted program ${uniqueId}`);

        let state = this._getSharedProgramState(uniqueId, false);
        if (state)
            state.processAbort(message.sender);

        // FINISHME
    }

    _handleRemoteData(feedId, message, parsed) {
        let uniqueId = parsed.uuid;
        let flow = parsed.f;
        let data;
        try {
            data = Protocol.params.unmarshal(parsed.d);
        } catch(e) {
            console.log('Failed to unmarshal remote data message from ' + message.sender + ': ' + e.message);
            return;
        }

        console.log('Received data message from ' + message.sender);
        console.log('Data size: ' + JSON.stringify(data).length);
        let state = this._getSharedProgramState(uniqueId, false);
        if (state)
            state.processData(message.sender, flow, data);
    }

    _handleRemoteEnd(feedId, message, parsed) {
        let uniqueId = parsed.uuid;
        let flow = parsed.f;

        console.log('Received end message from ' + message.sender);
        let state = this._getSharedProgramState(uniqueId, false);
        if (state)
            state.processEnd(message.sender, flow);
    }

    _handleRemoteJoin(feedId, message, parsed) {
        let uniqueId = parsed.uuid;

        console.log(`${message.sender} joined program ${uniqueId}`);
        let state = this._getSharedProgramState(uniqueId, false);
        if (state)
            state.processJoin(message.sender);
    }

    _normalizePrincipal(principal) {
        const userprefix = this._messaging.type + '-account:';
        const roomprefix = this._messaging.type + '-room:';
        if (Array.isArray(principal)) {
            principal = principal.map((p) => {
                p = String(p);
                if (p.startsWith(userprefix))
                    p = p.substr(userprefix.length);
                return p;
            });
        } else {
            principal = String(principal);
            if (principal.startsWith(userprefix))
                principal = [principal.substr(userprefix.length)];
            else if (principal.startsWith(roomprefix))
                principal = principal.substr(roomprefix.length);
        }

        return principal;
    }

    subscribe(principal, uniqueId, flow) {
        principal = this._normalizePrincipal(principal);
        let state = this._getSharedProgramState(String(uniqueId), true);
        return state.subscribe(principal, flow);
    }

    _typecheckProgram(code) {
        // we will show a confirmation string to the user and store it in the app database,
        // so always fetch metadata in addition to type information
        return Promise.resolve(ThingTalk.Grammar.parseAndTypecheck(code, this._schemaRetriever, true));
    }

    _handleInstallProgram(feedId, message, parsed) {
        if (this._tierManager.ownTier === 'cloud' &&
            (this._devices.hasDevice('thingengine-own-phone') ||
             this._devices.hasDevice('thingengine-own-desktop') ||
             this._devices.hasDevice('thingengine-own-server'))) {
            console.log('Ignoring install rule because another tier is also present');
            return false;
        }

        let uniqueId = parsed.uuid;
        let identity = parsed.id;
        let code = parsed.c;

        let feedPrincipal = this._messaging.type + '-room:' + feedId;
        this._getSharedProgramState(uniqueId, true);
        // join the program first
        return this._sendJoinProgram(feedPrincipal, uniqueId).then(() => {
            return this._typecheckProgram(code);
        }).then((program) => {
            return this._executor.installProgram(this._messaging.type + '-account:' + message.sender, identity, program, uniqueId).then(() => true);
        }).catch((error) => {
            this._subscriptions.delete(uniqueId);

            //if (!error.code)
                console.error(error);
            if (!error.code && error instanceof TypeError)
                error.code = 'EINVAL';
            return this.abortProgramRemote(feedPrincipal, uniqueId, error);
        }).catch((e) => {
            console.error(e);
            console.error('Failed to process remote execution request: ' + e.message);
        });
    }

    start() {
        this._messaging.on('incoming-message', this._incomingMessageListener);
        return Promise.resolve();
    }

    stop() {
        this._messaging.removeListener('incoming-message', this._incomingMessageListener);
        return Promise.resolve();
    }

    _getFeed(principal) {
        if (typeof principal === 'string')
            return this._messaging.getFeedByAlias(principal);
        return this._messaging.getFeedWithContact(principal).then((feed) => {
            return feed;
        });
    }

    _sendMessage(principal, msg) {
        principal = this._normalizePrincipal(principal);
        return this._getFeed(principal).then((feed) => {
            if (!feed)
                throw new Error('Invalid room, or failed to create room with contact');
            return feed.open().then(() => {
                msg.v = CURRENT_VERSION;
                return feed.sendItem(msg);
            });
        });
    }

    _sendJoinProgram(principal, uniqueId) {
        return this._sendMessage(principal, {
            op: Message.JOIN,
            uuid: uniqueId
        });
    }

    sendData(principal, uniqueId, flowId, data) {
        return this._sendMessage(principal, {
            op: Message.DATA,
            uuid: String(uniqueId),
            f: flowId,
            d: Protocol.params.marshal(data)
        });
    }

    sendEndOfFlow(principal, uniqueId, flowId) {
        return this._sendMessage(principal, {
            op: Message.END,
            uuid: String(uniqueId),
            f: flowId
        });
    }

    abortProgramRemote(principal, uniqueId, err) {
        return this._sendMessage(principal, {
            op: Message.ABORT,
            uuid: String(uniqueId),
            err: err ? { m: err.message, c: err.code } : null
        });
    }

    installProgramRemote (principal, identity, uniqueId, program) {
        return this._sendMessage(principal, {
            op: Message.INSTALL,
            uuid: String(uniqueId),
            id: identity,
            c: ThingTalk.Ast.prettyprint(program, true).trim()
        });
    }

    _handleGetTableSchema(feedId, message, parsed) {
        let reqId = parsed['#'];
        let table = parsed.t;

        // FIXME access control check

        let feedPrincipal = this._messaging.type + '-room:' + feedId;
        this._schemaRetriever.getMemorySchema(table, null /* principal */, false /* getMeta */).then((schema) => {
            if (!schema) {
                this._sendMessage(feedPrincipal, {
                    op: Message.TABLE_SCHEMA_REPLY,
                    '#': reqId,
                    err: { m: 'No such table ' + table, c: 'ENOENT' }
                });
                return;
            }

            this._sendMessage(feedPrincipal, {
                op: Message.TABLE_SCHEMA_REPLY,
                '#': reqId,
                types: schema.types.map((t) => String(t)),
                args: schema.args
            });
        }, (e) => {
            // some disk or database error? something messed up?
            // let the caller know
            console.log('Failed to retrieve memory schema: ' + e.message);
            this._sendMessage(feedPrincipal, {
                op: Message.TABLE_SCHEMA_REPLY,
                '#': reqId,
                err: { m: e.message, c: e.code }
            });
        }).catch((e) => {
            // something got horribly wrong (eg network error), just ignore the request
            // and let it timeout
            console.error(e);
            console.error('Failed to process remote execution request: ' + e.message);
        });
    }

    _handleTableSchemaReply(feedId, message, parsed) {
        let req = this._tableSchemaRequests.get(parsed['#']);
        if (!req) // ignore
            return;
        if (message.sender !== req.principal) // also ignore
            return;

        if (parsed.err) {
            if (parsed.err.c === 'ENOENT') {
                // no such table
                req.resolve(null);
                return;
            } else {
                let error = new Error(parsed.err.m);
                error.code = parsed.err.c;
                req.reject(error);
            }
            return;
        }

        if (!Array.isArray(parsed.types) || !Array.isArray(parsed.args) ||
            parsed.types.length !== parsed.args.length) {
            let error = new Error('Remote peer sent an bogus reply');
            error.code = 'EINVAL';
            req.reject(error);
            return;
        }

        try {
            parsed.args = parsed.args.map((a) => String(a));
            parsed.types = parsed.types.map((t) => ThingTalk.Type.fromString(t));
        } catch(e) {
            let error = new Error('Remote peer sent an bogus reply');
            error.code = 'EINVAL';
            req.reject(error);
            return;
        }

        req.resolve({ args: parsed.args, types: parsed.types });
    }

    getTableSchemaRemote(principal, table) {
        console.log('getTableSchemaRemote', principal, table);
        const reqId = this._nextRPCId++;
        const userprefix = this._messaging.type + '-account:';
        const roomprefix = this._messaging.type + '-room:';
        if (Array.isArray(principal) || principal.startsWith(roomprefix))
            return Promise.reject(new Error('Cannot gather table schemas'));
        if (principal.startsWith(userprefix))
            principal = principal.substr(userprefix.length);

        return new Promise((resolve, reject) => {
            this._tableSchemaRequests.set(reqId, { principal, resolve, reject });

            setTimeout(() => {
                reject(new Error('Request timed out'));
            }, 10000);
            this._sendMessage([principal], {
                op: Message.GET_TABLE_SCHEMA,
                t: String(table),
                '#': reqId
            }).catch(reject);
        }).finally(() => {
            this._tableSchemaRequests.delete(reqId);
        });
    }
};