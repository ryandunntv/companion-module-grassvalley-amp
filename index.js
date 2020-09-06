const tcp = require('../../tcp');
const instance_skel = require('../../instance_skel');

/**
 * AMP Protocol documentation:
 * http://www.gvgdevelopers.com/concrete/apis/amp_protocol/
 * http://www.gvgdevelopers.com/Protocols/AMP_SDK/Docs/AMP%20at%20a%20glance.pdf
 * http://www.gvgdevelopers.com/concrete/index.php/download_file/-/view/11/ (K2_Protocol_Developers_Guide.pdf)
 * http://www.gvgdevelopers.com/concrete/index.php/download_file/-/view/10 (AMP Specification)
 */

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

class instance extends instance_skel {
	constructor(system, id, config) {
		super(system, id, config);

		this.awaiting_reply = false;
		this.command_queue = [];
		this.files = [];
		this.last_bit_check = null;
		this.current_transport_status = null;

		// Number of ms to grab transport updates
		this.defineConst('TRANSPORT_UPDATES', 2000);
		// If we miss x status updates, let's attempt to reconnect
		this.defineConst('TCP_TIMEOUT', this.TRANSPORT_UPDATES * 5);

		this.transport_bits = {
			PLAY: {
				bit: 0,
				name: 'Playing',
			},
			RECORD: {
				bit: 1,
				name: 'Recording',
			},
			FF: {
				bit: 2,
				name: 'FF',
			},
			RW: {
				bit: 3,
				name: 'RW',
			},
			STOP: {
				bit: 5, // Warning: this seems to always be 0 although documentation says it will be set
				name: 'Stopped'
			}
		};

		this.actions(); // export actions
	}

	updateConfig(config) {
		if (this.config.host !== config.host || this.config.channel !== config.channel) {
			this.init_tcp();
		}

		this.config = config;
	}

	init() {
		this.status(this.STATE_UNKNOWN);
		this.init_tcp();
		this.initFeedbacks();
	}

	init_tcp() {
		if (this.socket !== undefined) {
			this.destroy();
		}

		if (this.config.host) {
			this.socket = new tcp(this.config.host, 3811);

			this.socket.on('status_change', (status, message) => {
				this.status(status, message);
			});

			this.socket.on('connect', () => {
				this.socket.socket.setTimeout(this.TCP_TIMEOUT);
				this.initAMPSocket();
			});

			this.socket.on('error', (err) => {
				this.debug("Network error", err);
				this.log('error',"Network error: " + err.message);
			});

			this.socket.socket.on('timeout', () => {
				this.socket.socket.end();
			});

			this.socket.on('end', () => {
				if (this.transport_timer) {
					clearTimeout(this.transport_timer);
				}
			});

			this.socket.on('data', (chunk) => {
				this.buffer = chunk;

				if (this.waiting_for_crat && this.buffer.length >= 4) {
					var result = this.buffer.slice(0, 4).toString();
					this.buffer = this.buffer.slice(4);

					this.waiting_for_crat = false;

					if (result.match(/1111/)) {
						this.log('error', 'Error opening AMP socket, server said NAK');
					}
					else if (result.match(/1001/)) {
						// ACKed, ok
						this.getFileList();
					} else {
						this.log('error', 'Unkown data received while connecting to device');
						this.debug('Did not expect: ' + result);
					}
				} else if (this.awaiting_reply) {
					if (this.buffer.length >= 4) {
						var str = this.buffer.toString();
						var cmd1 = parseInt(str[0], 16);
						var count = parseInt(str[1], 16);
						var cmd2 = parseInt(str[2] + str[3], 16);

						switch (cmd1) {
							case 8:
								if (cmd2 == 0x14) {
									this.handleListFirstID();
								} else
								if (cmd2 == 0x8A) {
									this.handleListNextID();
								}
								break;
							case 1:
								if (count == 0 && cmd2 == 1) { // ack
									this.buffer = this.buffer.slice(4);
								} else
								if (count == 1 && cmd2 == 0x12) {
									this.buffer = this.buffer.slice(6);
									this.log('error', 'Error received on last command');
									// Todo parse NAK bits
								}
								break;
							case 7:
								if (cmd2 == 0x20 && count == 2) { // 72.20
									this.handleTransportInfo(this.buffer);
								}
						}

						// Todo: fiks
						this.awaiting_reply = false;

						if (this.command_queue.length > 0) {
							this._sendCommand(this.command_queue.shift());
						}
					}
				}
			});
		}
	}

	getFileList() {
		// @todo it'd probably be a good idea to refresh to file list every X minutes
		this.files = [];
		this.sendCommand('a2140000');
		this.sendCommand('a115ff');
	}

	handleListFirstID() {
		let buffer = this.buffer.toString();

		this.debug('handleListFirstID: ', this.buffer[1], ' == a');
		if (buffer[1] == '0' && this.buffer.length >= 6) {
			this.debug('no clips');
			this.buffer = this.buffer.slice(6);
		} else if (buffer[1] == '8' && this.buffer.length >= 22) {
			this.debug('Clip 8 byte mode ' + Buffer.from(this.buffer.slice(4, 4 + 16).toString(), 'hex').toString());

			this.files.push(Buffer.from(this.buffer.slice(4, 4 + 16).toString(), 'hex').toString());
			this.buffer = this.buffer.slice(4 + 16 + 2);
		} else if (buffer[1] == 'A' || buffer[1] == 'a' && this.buffer.length >= 12) {
			var len = parseInt(buffer.substr(4,4), 16);
			this.debug("Going to try to read " + len + " bytes of clips");
			var i = 0;

			if (buffer.length < len*2) { return; }

			while (len > 0 && 8+4+i < buffer.length) {
				var len2 = parseInt(buffer.substr(8 + i, 4), 16);
				var name = buffer.substr(8+i+4, len2 * 2);
				this.debug("Clip: " + Buffer.from(name, 'hex').toString());
				this.files.push(Buffer.from(name, 'hex').toString());
				i += 4 + (len2 * 2);
			}

			this.buffer = this.buffer.slice(8 + (len * 2) + 2);
			this.actions();
		}
	}

	_getBit(byte, bit) {
		return (byte >> bit) % 2;
	}

	handleTransportInfo(buffer) {
		const bit_check = buffer.toString('utf8', 7, 8);

		if (bit_check !== this.last_bit_check) {
			this.last_bit_check = bit_check;
			if (this._getBit(bit_check, this.transport_bits.RECORD.bit)) {
				this.current_transport_status = 'recording';
			} else if (this._getBit(bit_check, this.transport_bits.PLAY.bit)) {
				this.current_transport_status = 'playing';
			} else if (this._getBit(bit_check, this.transport_bits.FF.bit)) {
				this.current_transport_status = 'ff';
			} else if (this._getBit(bit_check, this.transport_bits.RW.bit)) {
				this.current_transport_status = 'rw';
			} else {
				this.current_transport_status = 'stopped';
			}
			this.checkFeedbacks('transport');
		}

		this.transport_timer = setTimeout(this.statusUpdates.bind(this), this.TRANSPORT_UPDATES);
	}

	initAMPSocket() {
		// We don't want to keep waiting for data that'll never come...
		this.awaiting_reply = false;
		this.command_queue = [];

		const channel = this.config.channel;

		this.buffer = new Buffer('');

		if (channel !== undefined) {
			this.waiting_for_crat = true;
			this.socket.send('CRAT' + zpad(channel.length + 3, 4) + '2' + zpad(channel.length, 2) + channel + "\n");

			this.transport_timer = setTimeout(this.statusUpdates.bind(this), this.TRANSPORT_UPDATES);
		}
	}

	initFeedbacks() {
		const feedbacks = {
			transport: {
				label: 'Transport state changes',
				description: 'Changes feedback based on transport state',
				options: [
					{
						type: 'dropdown',
						label: 'Transport state',
						id: 'transport_state',
						default: 'playing',
						choices: [
							{ id: 'playing', label: 'Playing' },
							{ id: 'stopped', label: 'Stopped' },
							{ id: 'ff', label: 'Fast Forward' },
							{ id: 'rw', label: 'Rewind' },
							{ id: 'recording', label: 'Recording' }
						]
					},
					{
						type: 'colorpicker',
						label: 'Foreground color',
						id: 'fg',
						default: this.rgb(255, 255, 255)
					},
					{
						type: 'colorpicker',
						label: 'Background color',
						id: 'bg',
						default: this.rgb(255, 255, 255)
					},
					{
						type: 'textinput',
						label: 'Text',
						id: 'text',
						default: ''
					}
				]
			}
		};

		this.setFeedbackDefinitions(feedbacks);

		for(let feedback in feedbacks) {
			this.checkFeedbacks(feedback);
		}
	}

	feedback(feedback, bank) {
		if(feedback.type === 'transport' && feedback.options.transport_state === this.current_transport_status) {
			let ret = {};
			if(feedback.options.fg !== 16777215 || feedback.options.bg !== 16777215) {
				ret.color = feedback.options.fg;
				ret.bgcolor = feedback.options.bg;
			}
			if('text' in feedback.options && feedback.options.text !== '') {
				ret.text = feedback.options.text;
			}

			return ret;
		}
	}

	sendCommand(command) {
		if (!this.awaiting_reply) {
			this._sendCommand(command);
		} else {
			this.debug('queueing command ' + command);
			this.command_queue.push(command);
		}
	}

	statusUpdates() {
		this.sendCommand('612002');
	}

	_toHexLength(length) {
		return parseInt(length).toString(16);
	}

	_sendCommand(command) {
		let send_command;

		if (command.length > 9999) {
			this.log('error', 'Internal error, command too long');
			return;
		}

		if (this.socket !== undefined && this.socket.connected) {
			this.awaiting_reply = true;
			send_command = 'CMDS' + zpad(command.length, 4) + command;
			this.debug('Sending command: ' + send_command);
			this.socket.send(send_command + "\n");
		} else {
			this.debug('Socket not connected :(');
		}
	}

	// Return config fields for web config
	config_fields () {
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
				regex: this.REGEX_IP
			},
			{
				type: 'textinput',
				id: 'channel',
				label: 'AMP Channel',
				width: 6,
				default: 'Vtr1'
			}
		]
	}

	// When module gets deleted
	destroy() {
		if (this.socket !== undefined) {
			this.socket.send('STOP0000\n');
			this.socket.destroy();
			if (this.transport_timer) {
				clearTimeout(this.transport_timer);
			}
			delete this.socket;
		}

		this.debug("destroy", this.id);
	}

	actions(system) {
		this.system.emit('instance_actions', this.id, {
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
					},
					{
						label: 'Clip name',
						id: 'clipdd',
						type: 'dropdown',
						choices: [].concat(
							[ {id: '', label: ' - None - '} ],
							this.files.map((el) => {
								return { id: el, label: el }
							})
						)
					}
				]
			},
			'recordclip': {
				label: 'Record clip',
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
	}

	action(action) {
		let opt = action.options,
			clip;

		switch (action.action) {
			case 'play':
				this.sendCommand('2001');
				break;

			case 'stop':
				this.sendCommand('2000');
				break;

			case 'eject':
				this.sendCommand('200f');
				break;

			case 'record':
				this.sendCommand('2002');
				break;

			case 'loadclip':
				clip = opt.clipdd || opt.clip;
				this.sendCommand(this._buildCommand('4A14', [
					[clip, false, 4]
				]));
				break;

			case 'recordclip':
				clip = opt.clip;
				this.sendCommand(this._buildCommand('AE02', [
					['00000000', 8], // TC
					[clip, false, 4]
				]));
				break;
		}

		this.debug('action():', action.action);
	}

	/**
	 * Builds a command that can be sent to the device
	 * Automatically calculates the actual byte count
	 * @returns String
	 */
	_buildCommand(name, list) {
		// Bytes to hex
		// Length (false if no length, see next)
		// Add length before sending?
		let command = '',
			actual_byte_cnt = 0;

		list.forEach(function(cmd_str) {
			if(cmd_str[1] === false) {
				actual_byte_cnt += cmd_str[0].length + (cmd_str[2] / 2);
				command += zpad(cmd_str[0].length.toString(16), cmd_str[2]);
				command += str2hex(cmd_str[0]);
			} else {
				actual_byte_cnt += cmd_str[1] / 2;
				command += zpad(str2hex(cmd_str[0]), cmd_str[1]);
			}
		});

		return name + zpad(actual_byte_cnt.toString(16), 4) + command;
	}
}

exports = module.exports = instance;
