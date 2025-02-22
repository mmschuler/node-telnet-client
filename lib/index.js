'use strict'

const events = require('events')
const util = require("util")
const net = require('net')
const Duplex = require('stream').Duplex
const utils = require('./utils')

module.exports = class Telnet extends events.EventEmitter {
  constructor() {
    super()

    this.socket = null
    this.state = null
    this.lastMoreIndex = -1;
  }

  connect(opts) {
    let promise;
    promise = new Promise((resolve, reject) => {
      const host = (typeof opts.host !== 'undefined' ? opts.host : '127.0.0.1')
      const port = (typeof opts.port !== 'undefined' ? opts.port : 23)
      const localAddress = (typeof opts.localAddress !== 'undefined' ? opts.localAddress : '')
      const socketConnectOptions = (typeof opts.socketConnectOptions !== 'undefined' ? opts.socketConnectOptions : {})
      this.timeout = (typeof opts.timeout !== 'undefined' ? opts.timeout : 500)
      this.promptTimeoutId = null
      this.promptTimeout = (typeof opts.promptTimeout !== 'undefined' ? opts.promptTimeout : 10000)
      this.promptTimeoutRenew = true;

      // Set prompt regex defaults
      this.shellPrompt = (typeof opts.shellPrompt !== 'undefined' ? opts.shellPrompt : /(?:\/ )?#\s/)
      this.loginPrompt = (typeof opts.loginPrompt !== 'undefined' ? opts.loginPrompt : /login[: ]*$/i)
      this.passwordPrompt = (typeof opts.passwordPrompt !== 'undefined' ? opts.passwordPrompt : /Password[: ]*$/i)
      this.failedLoginMatch = opts.failedLoginMatch
      this.loginPromptReceived = false

      this.extSock = (typeof opts.sock !== 'undefined' ? opts.sock : undefined)
      this.debug = (typeof opts.debug !== 'undefined' ? opts.debug : false)
      this.username = (typeof opts.username !== 'undefined' ? opts.username : 'root')
      this.password = (typeof opts.password !== 'undefined' ? opts.password : 'guest')
      this.irs = (typeof opts.irs !== 'undefined' ? opts.irs : '\r\n')
      this.ors = (typeof opts.ors !== 'undefined' ? opts.ors : '\n')
      this.echoLines = (typeof opts.echoLines !== 'undefined' ? opts.echoLines : 1)
      this.stripShellPrompt = (typeof opts.stripShellPrompt !== 'undefined' ? opts.stripShellPrompt : true)
      this.pageSeparator = (typeof opts.pageSeparator !== 'undefined'
        ? opts.pageSeparator : '---- More')
      this.negotiationMandatory = (typeof opts.negotiationMandatory !== 'undefined'
        ? opts.negotiationMandatory : true)
      this.initialLFCR = (typeof opts.initialLFCR !== 'undefined' ? opts.initialLFCR : false)
      this.initialCTRLC = (typeof opts.initialCTRLC !== 'undefined' ? opts.initialCTRLC : false)
      this.execTimeout = (typeof opts.execTimeout !== 'undefined' ? opts.execTimeout : 2000)
      this.execIntervallId = null
      this.dataReceived = false

      this.sendTimeout = (typeof opts.sendTimeout !== 'undefined' ? opts.sendTimeout : 2000)
      this.maxBufferLength = (typeof opts.maxBufferLength !== 'undefined' ? opts.maxBufferLength : 1048576)
      this.enableMaxBuffer = !opts.enableMaxBuffer ? opts.enableMaxBuffer : true

      /* if socket is provided and in good state, just reuse it */
      if (this.extSock) {
        if (!this._checkSocket(this.extSock))
          return reject(new Error('socket invalid'))

        this.socket = this.extSock
        this.state = 'ready'
        this.emit('ready')

        resolve(this.shellPrompt)
      }
      else {
        this.socket = net.createConnection({
          port,
          host,
          localAddress,
          ...socketConnectOptions
        }, () => {
          this.state = 'start'
          this.emit('connect')

          if (this.initialCTRLC === true) this.socket.write(Buffer.from('03', 'hex'))
          if (this.initialLFCR === true) this.socket.write('\r\n')
          if (this.negotiationMandatory === false) resolve()
        })
      }

      this.inputBuffer = ''

      this.socket.setTimeout(this.timeout, () => {
        if (util.inspect(promise).includes("pending")) {
          /* if cannot connect, emit error and destroy */
          if (this.listeners('error').length > 0)
            this.emit('error', 'Cannot connect')

          this.socket.destroy()
          return reject(new Error('Cannot connect'))
        }
        this.emit('timeout')
        return reject(new Error('timeout'))
      })

      this.socket.on('data', data => {
        if (this.state === 'standby')
          return this.emit('data', data)

        if (this.state === 'getprompt' && this.promptTimeout && this.promptTimeoutRenew) {
          if (this.promptTimeoutId !== null) {
            clearTimeout(this.promptTimeoutId);
          }

          this.promptTimeoutRenew = false;
          this.promptTimeoutId = setTimeout(() => {
            this.destroy();
            reject('prompt timeout');
            return;
          }, this.promptTimeout);
        }

        this._parseData(data, (event, parsed) => {
          if (util.inspect(promise).includes("pending") && event === 'ready') {
              resolve(parsed)
          }
        })
      })

      this.socket.on('error', error => {
        if (this.listeners('error').length > 0)
          this.emit('error', error)

        if (util.inspect(promise).includes("pending")) {
          reject(error)
        }
      })

      this.socket.on('end', () => {
        this.emit('end')

        if (util.inspect(promise).includes("pending")) {
          reject(new Error('Socket ends'))
        }
      })

      this.socket.on('close', () => {
        this.emit('close')

        if (util.inspect(promise).includes("pending")) {
          reject(new Error('Socket closes'))
        }
      })
    });

    return promise;
  }

  shell() {
    return new Promise((resolve, reject) => {
      resolve(new Stream(this.socket))
    })
  }

  recurringExecTimeout(reject, responseHandler, buffExcHandler) {
    if (this.execTimeout) {
      if (this.execIntervallId != null) {
        clearInterval(this.execIntervallId);
      }
      this.execIntervallId = setInterval(() => {
        if (!this.dataReceived) {
          clearInterval(this.execIntervallId);
          this.execIntervallId = null

          this.removeListener('responseready', responseHandler)
          this.removeListener('bufferexceeded', buffExcHandler)

          reject(new Error('response not received'))
        }
        this.dataReceived = false;
      }, this.execTimeout)
    }
  }

  exec(cmd, opts) {
    return new Promise((resolve, reject) => {
      if (opts && opts instanceof Object) {
        this.shellPrompt = opts.shellPrompt || this.shellPrompt
        this.loginPrompt = opts.loginPrompt || this.loginPrompt
        this.failedLoginMatch = opts.failedLoginMatch || this.failedLoginMatch
        this.timeout = opts.timeout || this.timeout
        this.execTimeout = opts.execTimeout || this.execTimeout
        this.irs = opts.irs || this.irs
        this.ors = opts.ors || this.ors
        this.echoLines = (typeof opts.echoLines !== 'undefined' ? opts.echoLines : this.echoLines)
        this.maxBufferLength = opts.maxBufferLength || this.maxBufferLength
      }

      cmd += this.ors

      if (!this.socket.writable)
        return reject(new Error('socket not writable'))

      this.socket.write(cmd, () => {
        this.state = 'response'
        this.lastMoreIndex = -1;
        this.response = '';

        this.emit('writedone')

        this.once('responseready', responseHandler)
        this.once('bufferexceeded', buffExcHandler)

        this.recurringExecTimeout(reject, responseHandler, buffExcHandler)

        function responseHandler() {
          if (this.execIntervallId !== null) {
            clearInterval(this.execIntervallId)
          }

          if (this.response !== 'undefined') {
            resolve(this.response.join('\n'))
          }
          else reject(new Error('invalid response'))

          /* reset stored response */
          this.inputBuffer = ''

          /* set state back to 'standby' for possible telnet server push data */
          this.state = 'standby'

          this.removeListener('bufferexceeded', buffExcHandler)
        }

        function buffExcHandler() {
          if (this.execIntervallId !== null) {
            clearTimeout(this.execIntervallId)
          }

          if (!this.inputBuffer) return reject(new Error('response not received'))

          resolve(this.inputBuffer)

          /* reset stored response */
          this.inputBuffer = ''

          /* set state back to 'standby' for possible telnet server push data */
          this.state = 'standby'
        }
      })
    })
  }

  send(data, opts) {
    return new Promise((resolve, reject) => {
      if (opts && opts instanceof Object) {
        this.ors = opts.ors || this.ors
        this.sendTimeout = opts.timeout || this.sendTimeout
        this.maxBufferLength = opts.maxBufferLength || this.maxBufferLength
        this.waitfor = (opts.waitfor ? (opts.waitfor instanceof RegExp ? opts.waitfor : RegExp(opts.waitfor)) : false);
      }

      data += this.ors

      if (this.socket.writable) {
        this.socket.write(data, () => {
          let response = '';
          this.state = 'standby'

          this.on('data', sendHandler)

          if (!this.waitfor || !opts) {
            setTimeout(() => {
              if (response === '') {
                  this.removeListener('data', sendHandler)
                  reject(new Error('response not received'))
                  return
              }

              this.removeListener('data', sendHandler)
              resolve(response)
            }, this.sendTimeout)
          }

          const self = this

          function sendHandler(data) {
            response += data.toString()

            if (self.waitfor) {
              if (!self.waitfor.test(response)) return

              self.removeListener('data', sendHandler)
              resolve(response)
            }
          }
        })
      } else {
        reject(new Error('socket not writable'))
      }

    })
  }

  getSocket() {
    return this.socket
  }

  end() {
    return new Promise(resolve => {
      this.socket.end()
      resolve()
    })
  }

  destroy() {
    return new Promise(resolve => {
      this.socket.destroy()
      resolve()
    })
  }

  _parseData(chunk, callback) {
    let promptIndex = ''

    if (chunk[0] === 255 && chunk[1] !== 255) {
      this.inputBuffer = ''
      const negReturn = this._negotiate(chunk)

      if (negReturn == undefined) return
      else chunk = negReturn
    }

    if (this.state === 'start') {
      this.state = 'getprompt'
    }

    if (this.state === 'getprompt') {
      const stringData = chunk.toString()

      let promptIndex = utils.search(stringData, this.shellPrompt)

      if (utils.search(stringData, this.loginPrompt) !== -1) {
        /* make sure we don't end up in an infinite loop */
        if (!this.loginPromptReceived) {
          this.state = 'login'
          this._login('username')
          this.loginPromptReceived = true
          this.promptTimeoutRenew = true;
        }
      }
      else if (utils.search(stringData, this.passwordPrompt) !== -1) {
        this.state = 'login'
        this._login('password')
        this.promptTimeoutRenew = true;
      }
      else if (typeof this.failedLoginMatch !== 'undefined' && utils.search(stringData, this.failedLoginMatch) !== -1) {
        this.state = 'failedlogin'

        this.emit('failedlogin', stringData)
        this.destroy()
      }
      else if (promptIndex !== -1) {
        if (!(this.shellPrompt instanceof RegExp))
          this.shellPrompt = stringData.substring(promptIndex)

        this.state = 'standby'
        this.inputBuffer = ''
        this.loginPromptReceived = false

        if (this.promptTimeoutId) { clearTimeout(this.promptTimeoutId); this.promptTimeoutRenew = false; }

        this.emit('ready', this.shellPrompt)

        if (callback) callback('ready', this.shellPrompt)
      }

      else return
    }
    else if (this.state === 'response') {
      if (this.enableMaxBuffer && this.inputBuffer.length >= this.maxBufferLength) {
        return this.emit('bufferexceeded');
      }


      const stringData = chunk.toString()

      this.inputBuffer += stringData
      promptIndex = utils.search(this.inputBuffer, this.shellPrompt)

      if (stringData.length > 0) {
        this.dataReceived = true;
      }

      if (promptIndex === -1 && stringData.length !== 0) {
        let testChunk = stringData;
        if (this.lastMoreIndex > -1) {
          testChunk = this.inputBuffer.substr(this.lastMoreIndex + 4);
        }

        let foundIndex = utils.search(testChunk.replace(/\r?\n|\r/g, ''), this.pageSeparator);
        if (foundIndex !== -1) {
          this.lastMoreIndex = this.inputBuffer.length;
          this.socket.write(Buffer.from('20', 'hex'))
        }

        return
      }

      let response = this.inputBuffer.split(this.irs)
      for (let i = response.length - 1; i >= 0; --i) {
        if (utils.search(response[i], this.pageSeparator) !== -1) {
          response[i] = response[i].replace(this.pageSeparator, '')
          if (response[i].length === 0)
            response.splice(i, 1)
        }
      }

      if (this.echoLines === 1) response.shift()
      else if (this.echoLines > 1) response.splice(0, this.echoLines)

      /* remove prompt */
      if (this.stripShellPrompt) {
        const idx = response.length - 1;
        response[idx] = utils.search(response[idx], this.shellPrompt) > -1
          ? response[idx].replace(this.shellPrompt, '')
          : '';
      }
      this.response = response;

      this.emit('responseready')
    }
  }

  _login(handle) {
    if ((handle === 'username' || handle === 'password') && this.socket.writable) {
      this.socket.write(this[handle] + this.ors, () => {
        this.state = 'getprompt'
      })
    }
  }

  _negotiate(chunk) {
    /* info: http://tools.ietf.org/html/rfc1143#section-7
     * refuse to start performing and ack the start of performance
     * DO -> WONT WILL -> DO */
    const packetLength = chunk.length

    let negData = chunk
    let cmdData = null
    let negResp = null

    for (let i = 0; i < packetLength; i+=3) {
      if (chunk[i] != 255) {
        negData = chunk.slice(0, i)
        cmdData = chunk.slice(i)
        break
      }
    }

    negResp = negData.toString('hex').replace(/fd/g, 'fc').replace(/fb/g, 'fd')

    if (this.socket.writable) this.socket.write(Buffer.from(negResp, 'hex'))

    if (cmdData != undefined) return cmdData
    else return
  }

  _checkSocket(sock) {
    return this.extSock !== null &&
      typeof this.extSock === 'object' &&
      typeof this.extSock.pipe === 'function' &&
      this.extSock.writable !== false &&
      typeof this.extSock._write === 'function' &&
      typeof this.extSock._writableState === 'object' &&
      this.extSock.readable !== false &&
      typeof this.extSock._read === 'function' &&
      typeof this.extSock._readableState === 'object'
  }
}

class Stream extends Duplex {
  constructor(source, options) {
    super(options)
    this.source = source

    this.source.on('data', (data) => this.push(data))
  }

  _write(data, encoding, cb) {
    if (!this.source.writable) {
      cb(new Error('socket not writable'))
    }

    this.source.write(data, encoding, () => {
      this.push(data)
      cb()
    })
  }

  _read() {}
}
