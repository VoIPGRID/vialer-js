/**
* The Call module takes care of the plumbing involved with setting up
* and breaking down Calls. `AppForeground` interacts with this module
* by emitting events. The Calls module maintains the state bookkeeping
* of all the tracked Calls.
* @module ModuleCalls
*/
const Plugin = require('vialer-js/lib/plugin')


/**
* Main entrypoint for Calls.
* @memberof AppBackground.plugins
*/
class PluginCalls extends Plugin {
    /**
    * @param {AppBackground} app - The background application.
    */
    constructor(app) {
        super(app)

        this.callFactory = require('./call/factory')(this.app)
        // Keeps track of calls. Keys match Sip.js session keys.
        this.calls = {}
        // This flag indicates whether a reconnection attempt will be
        // made when the websocket connection is gone.

        this.reconnect = true
        // The default connection timeout to start with.
        this.retryDefault = {interval: 250, limit: 10000, timeout: 250}
        // Used to store retry state.
        this.retry = Object.assign({}, this.retryDefault)

        /**
         * Accept an incoming Call.
         * @event module:ModuleCalls#bg:calls:call_accept
         * @property {callId} callId - Id of the Call object to accept.
         */
        this.app.on('bg:calls:call_accept', ({callId}) => this.calls[callId].accept())
        /**
         * Set this Call to be the visible Call.
         * @event bg:calls:call_activate
         * @property {callId} callId - Id of the Call object to activate.
         * @property {Boolean} holdInactive - Whether to hold the other Calls.
         * @property {Boolean} unholdActive - Whether to unhold the activated Call.
         */
        this.app.on('bg:calls:call_activate', ({callId, holdInactive, unholdActive}) => {
            this.activateCall(this.calls[callId], holdInactive, unholdActive)
        })

        /**
        * Create - and optionally start - a new Call. This is the main
        * event used to start a call with.
        * @event module:ModuleCalls#bg:calls:call_create
        * @property {String} options.number - The number to call.
        * @property {String} [options.start] - Start calling right away or just create a Call instance.
        * @property {String} [options.type] - Class name of the Call implementation, e.g. a `CallSIP` instance.
        */
        this.app.on('bg:calls:call_create', ({callback, number, start, type}) => {
            // Always sanitize the number.
            number = this.app.utils.sanitizeNumber(number)

            // Deal with a blind transfer Call.
            let activeOngoingCall = this.findCall({active: true, ongoing: true})
            if (activeOngoingCall && activeOngoingCall.state.transfer.active && activeOngoingCall.state.transfer.type === 'blind') {
                // Directly transfer the number to the currently activated
                // call when the active call has blind transfer mode set.
                this.app.telemetry.event('call[sip]', 'transfer', 'blind')
                activeOngoingCall.transfer(number)
            } else {
                // Both a 'regular' new call and an attended transfer call will
                // create or get a new Call and activate it.
                let call = this._newCall({number, type})

                // An actual call may only be made when calling is enabled.
                if (start && !this.app.helpers.callingDisabled()) {
                    call.start()
                }
                // Sync the others transfer state of other calls to the new situation.
                this.__setTransferState()
                // A newly created call is always activated unless
                // there is another call already ringing.
                if (!Object.keys(this.calls).find((i) => ['create', 'invite'].includes(this.calls[i].state.status))) {
                    this.activateCall(call, true, true)
                }

                if (callback) callback({call: call.state})
            }
        })


        /**
        * Delete a Call instance. Only use this to cancel a new
        * unactivated Call. Use {@linkcode module:ModuleCalls#bg:calls:call_terminate|bg:calls:call_terminate}
        * to end a call.
        * @event module:ModuleCalls#bg:calls:call_delete
        * @property {callId} callId - Id of the Call object to delete.
        * @see module:ModuleCalls#bg:calls:call_terminate
        */
        this.app.on('bg:calls:call_delete', ({callId}) => {
            if (this.calls[callId]) this.deleteCall(this.calls[callId])
            else this.app.logger.debug(`${this}trying to delete non-existent Call with id ${callId}`)
        })


        /**
        * Terminate/Hangup an active Call.
        * @event module:ModuleCalls#bg:calls:call_terminate
        * @property {callId} callId - Id of the Call to delete.
        */
        this.app.on('bg:calls:call_terminate', ({callId}) => this.calls[callId].terminate())

        this.app.on('bg:calls:connect', ({}) => this.connect({register: this.app.state.settings.webrtc.enabled}))
        this.app.on('bg:calls:disconnect', ({reconnect}) => this.disconnect(reconnect))

        this.app.on('bg:calls:dtmf', ({callId, key}) => this.calls[callId].session.dtmf(key))
        this.app.on('bg:calls:hold_toggle', ({callId}) => {
            const call = this.calls[callId]
            if (!call.state.hold.active) {
                call.hold()
            } else {
                // Unhold while the call's transfer is active must also
                // undo the previously set transfer state on this call and
                // on others.
                if (call.state.transfer.active) {
                    // Unset the transfer state when it was active during an unhold.
                    this.__setTransferState(call, !call.state.transfer.active)
                }
                this.activateCall(call, true, true)
            }
        })


        /**
        * Toggle mute status on the call by manupilating the rtp
        * sender track of the Call.
        * @event module:ModuleCalls#bg:calls:mute_toggle
        * @property {callId} callId - Id of the Call to toggle mute for.
        */
        this.app.on('bg:calls:mute_toggle', ({callId}) => {
            const call = this.calls[callId]
            const rtpSenderTrack = call.pc.getSenders()[0].track

            if (!call.state.mute.active) {
                call.setState({mute: {active: true}})
                rtpSenderTrack.enabled = false
            } else {
                call.setState({mute: {active: false}})
                rtpSenderTrack.enabled = true
            }
        })


        /**
        * Finalizes an attended transfer.
        * @event module:ModuleCalls#bg:calls:transfer_finalize
        * @property {callId} callId - Id of the Call to transfer to.
        */
        this.app.on('bg:calls:transfer_finalize', ({callId}) => {
            // Find origin.
            let sourceCall
            for (const _callId of Object.keys(this.calls)) {
                if (this.calls[_callId].state.transfer.active) {
                    sourceCall = this.calls[_callId]
                }
            }
            this.app.telemetry.event('call[sip]', 'transfer', 'attended')
            sourceCall.transfer(this.calls[callId])
        })


        /**
         * Toggle hold for the call that needs to be transferred. Set
         * transfer mode to active for this call.
         * @event module:ModuleCalls#bg:calls:transfer_toggle
         * @property {callId} callId - Id of the Call to toggle transfer mode for.
         */
        this.app.on('bg:calls:transfer_toggle', ({callId}) => {
            const sourceCall = this.calls[callId]
            this.__setTransferState(sourceCall, !sourceCall.state.transfer.active)
        })
    }

    /**
    * Set the transfer state of a source call and update the transfer state of
    * other calls. This method doesn't change the intended transfer status
    * when no source Call is passed along. It just update outdated call state
    * in that case.
    * @param {Call} [sourceCall] - The call to update the calls status for.
    * @param {Boolean} active - The transfer status to switch or update to.
    */
    __setTransferState(sourceCall = {id: null}, active) {
        const callIds = Object.keys(this.calls)
        // Look for an active transfer call when the source call isn't
        // passed as a parameter.
        if (!sourceCall.id) {
            for (let _callId of callIds) {
                if (this.calls[_callId].state.transfer.active) {
                    sourceCall = this.calls[_callId]
                    // In this case we are not toggling the active status;
                    // just updating the status of other calls.
                    active = true
                    break
                }
            }
        }

        // Still no sourceCall. There is no transfer active at the moment.
        // Force all calls to deactivate their transfer.
        if (!sourceCall.id) active = false

        if (active) {
            // Enable transfer mode.
            if (sourceCall.id) {
                // Always disable the keypad, set the sourceCall on-hold and
                // switch to the default `attended` mode when activating
                // transfer mode on a call.
                sourceCall.setState({keypad: {active: false, number: ''}, transfer: {active: true, type: 'attended'}})
                sourceCall.hold()
            }
            // Set attended status on other calls.
            for (let _callId of callIds) {
                const _call = this.calls[_callId]
                if (_callId !== sourceCall.id) {
                    _call.setState({transfer: {active: false, type: 'accept'}})
                    // Hold all other ongoing calls.
                    if (!['new', 'create', 'invite'].includes(_call.state.status) && !_call.state.hold) {
                        _call.hold()
                    }
                }
            }
        } else {
            // Disable transfer mode.
            if (sourceCall.id) {
                sourceCall.setState({transfer: {active: false, type: 'attended'}})
                sourceCall.unhold()
            }
            // Set the correct state of all other calls; se the transfer
            // type to accept and disable transfer modus..
            for (let _callId of callIds) {
                const _call = this.calls[_callId]
                if (_callId !== sourceCall.id) {
                    this.calls[_callId].setState({transfer: {active: false, type: null}})
                    // Make sure all other ongoing calls stay on hold.
                    if (!['new', 'create', 'invite'].includes(_call.state.status) && !_call.state.hold) {
                        _call.hold()
                    }
                }
            }
        }
    }


    /**
    * Deal with events coming from a UA.
    */
    __uaEvents() {
        /**
        * An incoming call. Call-waiting is not implemented.
        * A new incoming call on top of a call that is already
        * ongoing will be silently terminated.
        */
        this.ua.on('invite', (session) => {
            this.app.logger.debug(`${this}<event:invite>`)
            const callIds = Object.keys(this.calls)
            const callOngoing = this.app.helpers.callOngoing()
            const closingCalls = this.app.helpers.callsClosing()
            const deviceReady = this.app.state.settings.webrtc.devices.ready
            const dnd = this.app.state.availability.dnd
            const microphoneAccess = this.app.state.settings.webrtc.media.permission

            let acceptCall = true
            let declineReason
            if (dnd || !microphoneAccess || !deviceReady) {
                acceptCall = false
                if (dnd) declineReason = 'dnd'
                if (!microphoneAccess) declineReason = 'microphone'
                if (!deviceReady) declineReason = 'device'
            }

            if (callOngoing) {
                // All ongoing calls are closing. Accept the call.
                if (callIds.length === closingCalls.length) {
                    acceptCall = true
                } else {
                    // Filter non-closing calls from all Call objects.
                    const notClosingCalls = callIds.filter((i) => !closingCalls.includes(i))
                    // From these Call objects, see which ones are not `new`.
                    const notClosingNotNewCalls = notClosingCalls.filter((i) => this.calls[i].state.status !== 'new')

                    if (notClosingNotNewCalls.length) {
                        acceptCall = false
                        declineReason = 'call ongoing'
                    } else acceptCall = true
                }
            }

            if (acceptCall) {
                // An ongoing call may be a closing call. In that case we first
                // remove all the closing calls before starting the new one.
                for (const callId of closingCalls) {
                    this.app.logger.debug(`${this}deleting closing call ${callId}.`)
                    this.deleteCall(this.calls[callId])
                }
            }
            // A declined Call will still be initialized, but as a silent
            // Call, meaning it won't notify the user about it.
            const call = this.callFactory(session, {silent: !acceptCall}, 'CallSIP')
            this.calls[call.id] = call
            call.start()

            if (!acceptCall) {
                this.app.logger.info(`${this}incoming call ${session.request.call_id} denied by invite handler: (${declineReason})`)
                call.terminate()
            } else {
                this.app.logger.info(`${this}incoming call ${session.request.call_id} allowed by invite handler`)
                Vue.set(this.app.state.calls.calls, call.id, call.state)
                this.app.emit('fg:set_state', {action: 'upsert', path: `calls.calls.${call.id}`, state: call.state})
            }
        })


        this.ua.on('registered', () => {
            this.app.logger.debug(`${this}<event:registered>`)
            if (this.__registerPromise) {
                this.__registerPromise.resolve()
                delete this.__registerPromise
            }
            this.app.setState({calls: {status: null, ua: {status: 'registered'}}})
            this.app.emit('calls:registered', {}, true)
        })


        this.ua.on('registrationFailed', () => {
            this.app.logger.debug(`${this}<event:registrationFailed>`)
            if (this.__registerPromise) {
                this.__registerPromise.reject()
                this.disconnect()
                delete this.__registerPromise
            }
            this.app.setState({calls: {status: null, ua: {status: 'registration_failed'}}})
        })


        this.ua.on('unregistered', () => {
            this.app.logger.debug(`${this}<event:unregistered>`)
            this.app.setState({calls: {ua: {status: this.ua.transport.isConnected() ? 'connected' : 'disconnected'}}})
        })
        this.ua.on('transportCreated', (transport) => {
            this.app.logger.debug(`${this}<event:transportCreated>`)

            this.ua.transport.on('connected', () => {
                this.app.logger.debug(`${this}<event:connected>`)
                this.app.setState({calls: {ua: {status: 'connected'}}})
                // Reset the retry interval timer..
                this.retry = Object.assign({}, this.retryDefault)
                this.app.emit('calls:connected', {}, true)
            })

            this.ua.transport.on('disconnected', () => {
                this.app.logger.debug(`${this}<event:disconnected>`)
                this.app.setState({calls: {ua: {status: 'disconnected'}}})

                if (this.app.state.user.authenticated) {
                    this.app.setState({calls: {ua: {status: 'disconnected'}}})
                } else {
                    this.app.setState({calls: {ua: {status: 'inactive'}}})
                    this.retry = Object.assign({}, this.retryDefault)
                    this.reconnect = false
                }

                // We don't use SIPJS reconnect logic, because it can't deal
                // with offline detection and incremental retry timeouts.
                if (this.reconnect) {
                    // Reconnection timer logic is performed only here.
                    this.app.logger.debug(`${this}reconnect in ${this.retry.timeout} ms`)
                    setTimeout(() => {
                        this.connect({register: this.app.state.settings.webrtc.enabled})
                    }, this.retry.timeout)
                    this.retry = this.app.timer.increaseTimeout(this.retry)
                }
            })
        })
    }


    /**
    * Setup the initial UA options. This depends for instance
    * on whether the application will be using the softphone
    * to connect to the backend with or the vendor portal user.
    * @param {Object} account - The SIP credentials to connect with.
    * @param {Object} account.username - Username to login with.
    * @param {Object} account.password - Password to login with.
    * @param {Object} account.uri - The SIP uri to login with.
    * @param {String} [endpoint] - The SIP endpoint.
    * @param {Object} [register] - Register to the SIP service.
    * @returns {Object} UA options that are passed to Sip.js
    */
    __uaOptions(account, endpoint = null, register = true) {
        const settings = this.app.state.settings

        // For webrtc this is a voipaccount, otherwise an email address.
        let options = {
            autostart: false,
            autostop: false,
            log: {
                builtinEnabled: false, // Don't write to console.
                level: 'debug',
                connector: this._sipjsLog.bind(this),
            },
            // Incoming unanswered calls are terminated after x seconds.
            noanswertimeout: 60,
            sessionDescriptionHandlerFactoryOptions: {
                constraints: {
                    audio: true,
                    video: false,
                },
                peerConnectionOptions: {
                    rtcConfiguration: {
                        iceServers: this.app.state.settings.webrtc.stun.map((i) => ({urls: i})),
                    },
                },
            },
            transportOptions: {
                // Reconnects are handled manually.
                maxReconnectionAttempts: 0,
                wsServers: `wss://${endpoint ? endpoint : settings.webrtc.endpoint.uri}`,
                traceSip: true,
            },
            userAgentString: this._userAgent(),
        }

        options.authorizationUser = account.username
        options.password = account.password
        options.uri = account.uri

        // Log in with the WebRTC voipaccount when it is enabled.
        // The voipaccount should be from the same client as the logged-in
        // user, or subscribe information won't work.
        if (settings.webrtc.enabled) {
            options.register = register
        } else {
            options.register = register
        }

        return options
    }


    /**
     * Handler called by SIPjs when a log message is produced.
     * @param {String} level - Level of the message: debug, log, warn or error.
     * @param {String} category - SIPjs instance class, for ex 'sipjs.ua'.
     * @param {String} label - Identifier of the class instance.
     * @param {String} content - Log message.
     */
    _sipjsLog(level, category, label, content) {
        let context = {category: category}
        if (label) context.label = label
        this.app.logger.debug(`[${category}] ${content}`, context)
    }


    /**
    * Initializes the module's store.
    * @returns {Object} The module's store properties.
    */
    _initialState() {
        return {
            calls: {},
            status: 'loading',
            ua: {
                status: 'inactive',
            },
        }
    }


    /**
    * Return a `Call` object that can be used to setup a new Call with,
    * depending on the current settings. This requires some extra
    * bookkeeping because settings may change in the meanwhile.
    * @param {Object} opts - Options to pass.
    * @param {String} [opts.type] - The type of call to find.
    * @param {String} [opts.number] - The number to call to.
    * @returns {Call} - A new or existing Call with status `new`.
    */
    _newCall({number = null, type} = {}) {
        let call

        for (const callId of Object.keys(this.calls)) {
            if (this.calls[callId].state.status !== 'new') continue

            // See if we can reuse an existing `new` Call object.
            if (type) {
                // Check if the found Call matches the expected type.
                if (this.calls[callId].constructor.name === type) {
                    call = this.calls[callId]
                } else this.deleteCall(this.calls[callId])
            } else {
                // When an empty call already exists, it must
                // adhere to the current WebRTC-SIP/ConnectAB settings
                // if the Call type is not explicitly passed.
                if (this.app.state.settings.webrtc.enabled) {
                    if (this.calls[callId].constructor.name === 'CallConnectAB') {
                        this.deleteCall(this.calls[callId])
                    } else {
                        call = this.calls[callId]
                    }
                } else {
                    if (this.calls[callId].constructor.name === 'CallSIP') {
                        this.deleteCall(this.calls[callId])
                    } else call = this.calls[callId]
                }
            }

            if (this.calls[callId]) call = this.calls[callId]
            break
        }

        if (!call) {
            call = this.callFactory(number, {}, type)
        }
        this.calls[call.id] = call
        // Set the number and propagate the call state to the foreground.
        call.state.number = number
        call.setState(call.state)

        // Sync the store's reactive properties to the foreground.
        if (!this.app.state.calls.calls[call.id]) {
            Vue.set(this.app.state.calls.calls, call.id, call.state)
            this.app.emit('fg:set_state', {action: 'upsert', path: `calls.calls.${call.id}`, state: call.state})
        }

        // Always set the number in the local state.
        this.app.logger.debug(`${this}_newCall ${call.constructor.name} instance`)
        return call
    }


    _ready() {
        if (!this.app.state.app.online) {
            this.app.setState({calls: {status: null}})
        }
    }


    /**
    * Restore stored dumped state from localStorage.
    * @param {Object} moduleStore - Root property for this module.
    */
    _restoreState(moduleStore) {
        Object.assign(moduleStore, {
            calls: {},
            status: 'loading',
            ua: {
                status: 'disconnected',
            },
        })
    }


    /**
    * Build the useragent to identify Vialer-js with.
    * The format is `Vialer-js/<VERSION> (<OS>/<ENV>) <Vendor>`.
    * Don't change this string lightly since third-party
    * applications depend on it.
    * @returns {String} - Useragent string.
    */
    _userAgent() {
        const env = this.app.env
        // Don't use dynamic extension state here as version.
        // Vialer-js may run outside of an extension's (manifest)
        // context. Also don't use template literals, because envify
        // can't deal with string replacement otherwise.
        let userAgent = 'Vialer-js/' + process.env.VERSION + ' '
        if (env.isLinux) userAgent += '(Linux/'
        else if (env.isMacOS) userAgent += '(MacOS/'
        else if (env.isWindows) userAgent += '(Windows/'

        if (env.isChrome) userAgent += 'Chrome'
        if (env.isElectron) userAgent += 'Electron'
        else if (env.isFirefox) userAgent += 'Firefox'
        else if (env.isEdge) userAgent += 'Edge'
        userAgent += `) ${this.app.state.app.vendor.name}`
        return userAgent
    }


    /**
    * Delegate call-related actions.
    * @returns {Object} - Properties that need to be watched.
    */
    _watchers() {
        return {
            /**
            * Respond to network changes.
            * @param {Boolean} online - Whether we are online now.
            */
            'store.app.online': (online) => {
                if (online) {
                    // We are online again, try to reconnect and refresh API data.
                    this.app.logger.debug(`${this}reconnect sip service (online modus)`)
                    this.connect({register: this.app.state.settings.webrtc.enabled})
                } else {
                    // Offline modus is not detected by Sip.js/Websocket.
                    // Disconnect manually.
                    this.app.logger.debug(`${this}disconnect sip service (offline modus)`)
                    this.disconnect(false)
                }
            },
            /**
            * Modify the menubar event icon when there is
            * no more ongoing call.
            */
            'store.calls.calls': () => {
                const ongoingCall = this.findCall({ongoing: true})
                if (!ongoingCall && ['calling', 'ringing'].includes(this.app.state.ui.menubar.event)) {
                    this.app.setState({ui: {menubar: {event: null}}})
                }
            },
            /**
            * Watch for changes in UA status and update the menubar
            * status accordingly. The menubar states are slightly
            * different from the UA states, because there are conditions
            * involved, besides the UA's.
            * @param {String} uaStatus - The new UA status.
            */
            'store.calls.ua.status': (uaStatus) => {
                if (this.app.state.settings.webrtc.enabled) {
                    if (uaStatus === 'registered') this.app.setState({calls: {status: null}})
                } else if (uaStatus === 'connected') this.app.setState({calls: {status: null}})

                this.app.plugins.ui.menubarState()
            },
        }
    }


    /**
    * Set the active state on the target call, un-hold the call and
    * put all other calls on-hold.
    * @param {Call} [call] - A Call to activate.
    * @param {Boolean} [holdOthers] - Unhold the call on activation.
    * @param {Boolean} [unholdOwn] - Unhold the call on activation.
    * @returns {Call|Boolean} - The Call or false.
    */
    activateCall(call, holdOthers = true, unholdOwn = false) {
        const callIds = Object.keys(this.calls)

        if (!call) {
            // Activate the first found ongoing call when no call is given.
            for (const callId of callIds) {
                // Don't select a call that is already closing.
                if (!['answered_elsewhere', 'bye', 'request_terminated', 'callee_busy'].includes(this.calls[callId].state.status)) {
                    call = this.calls[callId]
                }
            }

            if (!call) {
                this.app.logger.debug(`${this}no call to activate!`)
                return false
            }
        }
        for (const callId of Object.keys(this.calls)) {
            let _call = this.calls[callId]
            // A call that is closing. Don't bother changing hold
            // and active state properties.
            if (call.id === callId) {
                call.setState({active: true})
                // Only unhold calls that are in the right state.
                if (unholdOwn && _call.state.status === 'accepted') {
                    _call.unhold()
                }
            } else {
                _call.setState({active: false})
                // Only hold calls that are in the right state.
                if (holdOthers && _call.state.status === 'accepted') {
                    _call.hold()
                }
            }
        }

        return call
    }


    /**
    * A loosely coupled Call action handler. Operates on all current Calls.
    * Supported actions are:
    *   `accept-new`: Accepts an incoming call or switch to the new call dialog.
    *   `deline-hangup`: Declines an incoming call or an active call.
    *   `hold-active`: Toggle hold on the active call.
    * @param {String} action - The action; `accept-new` or `decline`.
    */
    callAction(action) {
        let inviteCall = null

        for (const callId of Object.keys(this.calls)) {
            // Don't select a call that is already closing
            if (this.calls[callId].state.status === 'invite') {
                inviteCall = this.calls[callId]
            }
        }

        const activeCall = this.findCall({active: true, ongoing: true})

        if (action === 'action-accept-hangup') {

            if (inviteCall) inviteCall.accept()
            else if (activeCall) activeCall.terminate()
        } else if (action === 'action-decline-new') {
            if (inviteCall) inviteCall.terminate()
            else if (activeCall) {
                const call = this._newCall()
                this.activateCall(call, true)
                this.app.setState({ui: {layer: 'calls'}})
            }
        } else if (action === 'action-hold-active') {
            // Make sure the action isn't provoked on a closing call.
            if (activeCall) {
                if (activeCall.state.hold.active) activeCall.unhold()
                else activeCall.hold()
            }
        }
    }


    /**
    * Initialize the SIPJS UserAgent and register its events.
    * Connection details can be passed or substracted from the
    * state. This is because the connect method is also used
    * to determine a succesful login; and before login there
    * is no state to get credentials from yet.
    * @param {Boolean} [register] - Whether to register to the SIP endpoint.
    */
    async connect({account = {}, endpoint = null, register = true} = {}) {
        this.app.logger.info(`${this}connect to ua (${register ? 'register' : 'no-register'})`)
        // The default is to reconnect.
        this.reconnect = true

        if (!account.username || !account.password || !account.uri) {
            account = this.app.state.settings.webrtc.account.using
        } else {
            this.app.setState({settings: {webrtc: {account: {using: account}}}})
        }

        this._uaOptions = this.__uaOptions(account, endpoint, register)

        // Login with the WebRTC account or platform account.
        if (!this._uaOptions.authorizationUser || !this._uaOptions.password) {
            this.app.logger.error(`${this}cannot connect without username and password`)
        }

        // Overwrite the existing instance with a new one every time.
        // SIP.js doesn't handle resetting configuration well.
        this.ua = new SIP.UA(this._uaOptions)
        this.__uaEvents()
        this.ua.start()
    }


    /**
    * Take care of cleaning up an ending call.
    * @param {Call} call - The call object to remove.
    */
    deleteCall(call) {
        // This call is being cleaned up; move to a different call
        // when this call was the active call.
        if (call.state.active) {
            let newActiveCall = null
            let fallbackCall = null
            for (const callId of Object.keys(this.calls)) {
                // We are not going to activate the Call we are deleting.
                if (callId === call.id) continue

                // Prefer not to switch to a call that is already closing.
                if (['answered_elsewhere', 'bye', 'request_terminated', 'callee_busy'].includes(this.calls[callId].state.status)) {
                    // The fallback Call is a non-specific closing call.
                    if (this.calls[callId]) fallbackCall = this.calls[callId]
                } else {
                    newActiveCall = this.calls[callId]
                    break
                }
            }

            // Select the first closing Call when all Calls are closing.
            if (newActiveCall) this.activateCall(newActiveCall, true, false)
            else if (fallbackCall) this.activateCall(fallbackCall, true, false)
        }

        // Finally delete the call and its references.
        this.app.logger.debug(`${this}delete call ${call.id}`)
        Vue.delete(this.app.state.calls.calls, call.id)
        delete this.calls[call.id]

        this.app.emit('fg:set_state', {action: 'delete', path: `calls.calls.${call.id}`})
    }


    /**
    * Graceful stop, do not reconnect automatically.
    * @param {Boolean} reconnect - Whether try to reconnect.
    */
    disconnect(reconnect = true) {
        this.app.logger.info(`${this}disconnect ua (reconnect: ${reconnect ? 'yes' : 'no'})`)
        this.reconnect = reconnect
        this.retry.timeout = 0

        this.app.setState({calls: {status: reconnect ? 'loading' : null, ua: {status: 'disconnected'}}})
        this.ua.unregister()
        this.ua.transport.disconnect()
        this.ua.transport.disposeWs()
        if (reconnect) {
            this.connect()
        }
    }


    /**
    * @param {Object} options - Options to pass.
    * @param {Boolean} [options.ongoing] - Find the first Call that is going on.
    * @returns {Call|null} - the current active ongoing call or null.
    */
    findCall({active = false, ongoing = false} = {}) {
        let matchedCall = null
        for (const callId of Object.keys(this.calls)) {
            // Don't select a call that is already closing.
            if (active) {
                if (this.calls[callId].state.active) {
                    if (ongoing) {
                        if (this.calls[callId].state.status === 'accepted') matchedCall = this.calls[callId]
                    } else {
                        matchedCall = this.calls[callId]
                    }
                }
            } else {
                if (ongoing) {
                    if (this.calls[callId].state.status === 'accepted') matchedCall = this.calls[callId]
                }
            }
        }
        return matchedCall
    }


    register(...args) {
        return new Promise((resolve, reject) => {
            this.__registerPromise = {reject, resolve}
            this.connect(...args)
        })
    }


    /**
    * Generate a representational name for this module. Used for logging.
    * @returns {String} - An identifier for this module.
    */
    toString() {
        return `${this.app}[calls] `
    }
}

module.exports = PluginCalls
