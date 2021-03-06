'use strict';

var net = require('net');
var events = require('events');
var util = require('util');

function RoundRobinLoadBalancer(spec) {
    if (!(this instanceof RoundRobinLoadBalancer)) {
        return new RoundRobinLoadBalancer(spec);
    }
    this.logger = spec.logger;
    this.port = spec.port;
    this.requestedAddress = spec.address;
    this.requestedBacklog = spec.backlog;
    this.address = null; // The actual address granted by the system.
    this.server = null;
    // The period to wait before attempting to restart a server that dies:
    this.restartDelay = spec.restartDelay || 0;

    // One of 'standby', 'starting', 'running', 'stopping'.
    // State machine looks like:
    // - 'standby': start() causes server.listen() -> 'starting'
    // - 'starting': server 'listening' -> 'running'
    // - 'running': stop() causes server.close() -> 'stopping'
    // - 'running': server 'close' -> 'standby'
    // - 'running': server 'error' -> 'standby'
    // - 'stopping': server 'close' -> 'standby'
    this.state = 'standby';
    // A flag that indicates that although this is 'stopping', it should
    // immediately restart once it has fully stopped.
    this.nextState = null;

    // The worker supervisors that are participating in this load balancer, in
    // the order that they will be sent connections.
    this.ring = this.Ring();
    // In the 'starting' state,
    // Workers that are awaiting a 'listening' or 'error' message.
    this.waitingWorkers = null;
    // Outside the 'running' state,
    // Connections that are waiting for a worker to join the ring.
    this.queue = [];

    this.restartTimeoutHandle = null;

    // Bind these methods once instead of creating a closure each time they are
    // used to receive events from this load balancer's server.
    this.handleListening = this.handleListening.bind(this);
    this.handleConnection = this.handleConnection.bind(this);
    this.handleError = this.handleError.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.handleRestartTimeout = this.handleRestartTimeout.bind(this);

    this.start();
}

util.inherits(RoundRobinLoadBalancer, events.EventEmitter);

RoundRobinLoadBalancer.prototype.Ring = Array; // TODO require('./_ring');

RoundRobinLoadBalancer.prototype.inspect = function () {
    return {
        state: this.state,
        port: this.port,
        address: this.address,
        backlog: this.queue.length
    };
};

RoundRobinLoadBalancer.prototype.addWorkerSupervisor = function (workerSupervisor) {
    this.ring.push(workerSupervisor);
    this.logger.debug('worker subscribed to connections', {
        id: workerSupervisor.id,
        port: this.port,
        count: this.ring.length
    });
    if (this.state === 'running') {
        workerSupervisor.sendAddress(this.port, this.address);
    }
    this.flushConnectionQueue();
};

RoundRobinLoadBalancer.prototype.removeWorkerSupervisor = function (workerSupervisor) {
    var index = this.ring.indexOf(workerSupervisor);
    if (index >= 0) {
        this.ring.splice(index, 1);
    }
    // We ignore the case when the worker supervisor is not in the ring because we
    // attempt to remove the worker early (when we tell a worker to stop) as
    // well as when it is confirmed closed (regardless of whether we asked it to).
};

// Used by the cluster supervisor to enumerate workers that need to be removed
// from circulation.
RoundRobinLoadBalancer.prototype.forEachWorkerSupervisor = function (callback, thisp) {
    this.ring.forEach(function (workerSupervisor) {
        callback.call(thisp, workerSupervisor, workerSupervisor.port, this);
    }, this);
};

RoundRobinLoadBalancer.prototype.goto = function (state) {
    this.state = state;
    this.emit(state, this);
    this.emit('stateChange', this.state, this);
};

RoundRobinLoadBalancer.prototype.start = function () {
    if (this.state === 'standby') {
        this.goto('starting');

        var server = net.createServer();
        this.server = server;

        server.on('listening', this.handleListening);
        server.on('connection', this.handleConnection);
        server.on('error', this.handleError);
        server.on('close', this.handleClose);

        this.logger.debug('supervisor requesting to listen on port', {
            port: this.port
        });
        this.server.listen(this.port || 0, this.requestedAddress, this.requestedBacklog);

    } else if (this.state === 'stopping') {
        this.nextState = 'starting';
    }
    // Nothing to do if 'running'
    // Nothing to do if 'starting'
};

RoundRobinLoadBalancer.prototype.stop = function (callback) {
    if (callback) {
        if (this.state !== 'standby') {
            this.once('standby', callback);
        } else {
            process.nextTick(callback);
        }
    }

    if (this.state === 'running' || this.state === 'starting') {
        // We can only close the server while it is running.
        // We will have to wait in the 'stopping' state for the server to come
        // up and then stop it.
        if (this.state === 'running') {
            this.server.close();
        }
        this.goto('stopping');
    }
    // Nothing to do if 'stopping'
    // Nothing to do if 'standby'
};

RoundRobinLoadBalancer.prototype.handleListening = function () {
    if (this.state === 'starting') {
        this.goto('running');

        this.address = this.server.address();
        this.logger.debug('supervisor received address to listen on port', {
            port: this.port,
            address: this.address
        });
        // Inform all workers that they are now listening and the name of their
        // actual address.
        this.ring.forEach(function (workerSupervisor) {
            workerSupervisor.sendAddress(this.port, this.address);
        }, this);
        this.flushConnectionQueue();
    } else if (this.state === 'stopping') {
        this.logger.warn('supervisor shutting down server before confirmed to be listening', {
            port: this.port
        });
        // This will occur if we stop while starting.
        // In that case, we transition to the 'stopping' state, but must wait
        // for this 'listening' event before we can attempt to stop the server.
        this.server.close();
    }
    // It may be possible for a server to emit a 'listening' event outside the
    // 'starting' state if we close a server before receiving the 'listening'
    // event. That would constitute a Node.js core bug, but would not interfere
    // with our normal operation.
};

RoundRobinLoadBalancer.prototype.handleError = function (error) {
    // TODO write code to recover from this error
    this.logger.error('supervisor failed to listen', {
        port: this.port,
        error: error
    });
    if (this.state === 'running' || this.state === 'stopping') {
        this.ring.forEach(function (workerSupervisor) {
            workerSupervisor.sendError(this.port, error);
        }, this);
        this.stop();
    } else if (this.state === 'starting') {
        this.stop();
    } else { // 'standby'
        // The Node.js server should not emit an 'error' when we are in
        // 'standby' state.
        throw error;
    }
};

RoundRobinLoadBalancer.prototype.handleConnection = function (connection) {
    if (this.state === 'running' && this.ring.length) {
        var workerSupervisor = this.ring.shift();
        this.ring.push(workerSupervisor);
        workerSupervisor.handleConnection(this.port, connection);
    } else { // starting, stopping
        this.queue.push(connection);
        // TODO remove connections that are closed or errored, or old if the
        // backlog is long.
        this.logger.info('connection backlog', {
            port: this.port,
            length: this.queue.length,
            grew: true
        });
    }
};

RoundRobinLoadBalancer.prototype.handleClose = function () {
    // A 'close' event might be in response to a requested server close or a
    // consequence of an error.
    // The order of 'error' and 'close' events is not certain.
    // As such, a 'close' event might occur while in either 'stopping' or
    // 'running' states.
    if (this.state === 'stopping' || this.state === 'running') {
        this.goto('standby');

        this.logger.info('supervisor stopped listening on port', {
            port: this.port
        });
        if (this.nextState === 'starting') {
            this.restartTimeoutHandle = setTimeout(this.handleRestartTimeout, this.restartDelay);
            this.nextState = null;
        }
    } else { // 'standby'
        throw new Error('Assertion failed: close event not expected when server is not running');
    }
};

RoundRobinLoadBalancer.prototype.handleRestartTimeout = function () {
    this.start();
};

// Called when a worker is introduced to the ring, in case the ring was empty
// when the connection was received.
// Called when the load balancer enters the 'running' state because it is ready
// to accept connections (This might be superfluous if the worker ring always
// starts empty, assuming that the shutdown removes all the workers from the
// ring properly).
RoundRobinLoadBalancer.prototype.flushConnectionQueue = function () {
    // TODO this could cause a large number of connections to be sent to a
    // single worker, if the load balancer and all workers are initially at
    // standby and one worker becomes available.
    if (this.state === 'running' && this.ring.length) {
        this.queue.forEach(function (connection) {
            this.handleConnection(connection);
        }, this);
        this.queue.length = 0;
        this.logger.debug('connection backlog', {
            port: this.port,
            length: 0,
            grew: false
        });
    }
};

module.exports = RoundRobinLoadBalancer;

