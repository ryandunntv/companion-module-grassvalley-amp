var tcp = require('../../tcp');
var instance_skel = require('../../instance_skel');
var debug;
var log;

// http://www.gvgdevelopers.com/concrete/apis/amp_protocol/
// http://www.gvgdevelopers.com/Protocols/AMP_SDK/Docs/AMP%20at%20a%20glance.pdf
// http://www.gvgdevelopers.com/concrete/index.php/download_file/-/view/11/ (K2_Protocol_Developers_Guide.pdf)
// http://www.gvgdevelopers.com/concrete/index.php/download_file/-/view/10 (AMP Specification)

function zpad(data, length) {
	return ('0'.repeat(length) + data).substr(0-length);
};

function str2hex(str) {
	var result = '';

	for (var i = 0; i < str.length; ++i) {
		result += zpad(str.charCodeAt(i).toString(16), 2);
	}

	return result;
}

function instance(system, id, config) {
	var self = this;

	self.awaiting_reply = false;
	self.command_queue = [];

	// super-constructor
	instance_skel.apply(this, arguments);

	self.actions(); // export actions

	return self;
}

instance.prototype.updateConfig = function(config) {
	var self = this;

	self.config = config;
	self.init_tcp();
};

instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;

	self.status(self.STATE_UNKNOWN);

	self.init_tcp();
};

instance.prototype.init_tcp = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
		delete self.socket;
	}

	if (self.config.host) {
		self.socket = new tcp(self.config.host, 3811);

		self.socket.on('status_change', function (status, message) {
			self.status(status, message);
		});

		self.socket.on('connect', function () {
			self.initAMPSocket();
		});

		self.socket.on('error', function (err) {
			debug("Network error", err);
			self.log('error',"Network error: " + err.message);
		});

		self.socket.on('data', function (chunk) {
			self.buffer = Buffer.concat([self.buffer, chunk]);

			if (self.waiting_for_crat && self.buffer.length >= 4) {
				var result = self.buffer.slice(0, 4).toString();
				self.buffer = self.buffer.slice(4);

				self.waiting_for_crat = false;

				if (result.match(/1111/)) {
					self.log('error', 'Error opening AMP socket, server said NAK');
				}
				else if (result.match(/1001/)) {
					// ACKed, ok
				} else {
					self.log('error', 'Unkown data received while connecting to device');
					debug('Did not expect: ' + result);
				}
			} else if (self.awaiting_reply) {
				// todo,fix
				if (self.buffer.length >= 4) {
					var result = self.buffer.slice(0, 4).toString();
					self.buffer = self.buffer.slice(4);

					self.awaiting_reply = false;

					if (result.match(/^1111/)) {
						self.log('error', 'Got an error from server after last command');
					}

					if (self.command_queue.length > 0) {
						self._sendCommand(self.command_queue.shift());
					}
				}
			}
		});
	}
};

instance.prototype.initAMPSocket = function() {
	var self = this;
	var channel = self.config.channel;

	self.buffer = new Buffer('');

	if (channel !== undefined) {
		self.waiting_for_crat = true;
		self.socket.send('CRAT' + zpad(channel.length + 3) + '2' + zpad(channel.length, 2) + channel + "\n");
	}
};

instance.prototype.sendCommand = function(command) {
	var self = this;

	if (!self.awaiting_reply) {
		self._sendCommand(command);
	} else {
		debug('queueing command ' + command);
		self.command_queue.push(command);
	}
};

instance.prototype._sendCommand = function(command) {
	var self = this;

	if (command.length > 9999) {
		self.log('error', 'Internal error, command too long');
		return;
	}

	if (self.socket !== undefined && self.socket.connected) {
		self.awaiting_reply = true;
		self.socket.send('CMDS' + zpad(command.length, 4) + command + "\n");
	} else {
		debug('Socket not connected :(');
	}
};

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this;
	return [
		{
			type: 'text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: "This module connects to VTR's that support the AMP protocol"
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Device IP',
			width: 6,
			regex: self.REGEX_IP
		},
		{
			type: 'textinput',
			id: 'channel',
			label: 'AMP Channel',
			width: 6,
			default: 'Vtr1'
		}
	]
};

// When module gets deleted
instance.prototype.destroy = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
	}

	debug("destroy", self.id);
};


instance.prototype.actions = function(system) {
	var self = this;

	self.system.emit('instance_actions', self.id, {
		'play': { label: 'Play' },
		'stop': { label: 'Stop' },
		'eject': { label: 'Eject' },
		'record': { label: 'Record' },
		'loadclip': {
			label: 'Load clip',
			options: [
				{
					label: 'Clip name',
					id: 'clip',
					type: 'textinput',
					regex: '/^\\S.*$/'
				}
			]
		}
	});
};

instance.prototype.action = function(action) {
	var self = this;
	var cmd;
	var opt = action.options;

	switch (action.action) {

		case 'play':
			self.sendCommand('2001');
			break;

		case 'stop':
			self.sendCommand('2000');
			break;

		case 'eject':
			self.sendCommand('200f');
			break;

		case 'record':
			self.sendCommand('2002');
			break;

		case 'loadclip':
			self.sendCommand('4041');
			self.sendCommand('4a14' + zpad(opt.clip.length + 2, 4) + zpad(opt.clip.length, 4) + str2hex(opt.clip));
	}

	debug('action():', action.action);
};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
