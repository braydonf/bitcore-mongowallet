'use strict';

var cluster = require('cluster');
var net = require('net');
var assert = require('assert');
var numCPUs = require('os').cpus().length;

var async = require('async');
var express = require('express');
var lmdb = require('node-lmdb');
var morgan = require('morgan');
var bodyParser = require('body-parser');
var compression = require('compression');
var bitcore = require('bitcore-lib');
var _ = require('lodash');
var bodyParser = require('body-parser');
var compression = require('compression');
var morgan = require('morgan');

var db = require('./db');
var Config = require('./config');
var models = require('./models');
var utils = require('./utils');
var validators = require('./validators');
var version = require('../package.json').version;

function WebWorker(options) {
  this.db = null;
  this._initOptions(options);
  this._initClients();
}

WebWorker.prototype._initOptions = function(options) {

  this.network = bitcore.Networks.get(options.network);
  assert(this.network, '"network" is an expected option, please specify "livenet", "testnet" or "regtest"');

  assert(options.bitcoinHeight >= 0, '"bitcoinHeight" is expected');
  assert(options.bitcoinHash, '"bitcoinHash" is expected');
  assert(options.clientsConfig && options.clientsConfig.length > 0, '"clientsConfig" is expected');
  assert(options.port, '"port" is an expected option');
  assert(options.writerSocketPath, '"writerSocketPath" is an expected option');

  this.port = options.port;
  this.bitcoinHeight = options.bitcoinHeight;
  this.bitcoinHash = options.bitcoinHash;
  this.clientsConfig = options.clientsConfig;
  this.writerSocketPath = options.writerSocketPath;

  this._stopping = false;

  this.config = new Config({
    network: options.network,
    path: options.configPath
  });

  this.safeConfirmations = options.safeConfirmations || WebWorker.DEFAULT_SAFE_CONFIRMATIONS;
};

WebWorker.DEFAULT_SAFE_CONFIRMATIONS = 12;

WebWorker.prototype.start = function(callback) {
  var self = this;
  var dbPath = self.config.getDatabasePath();
  self.db = db.open(dbPath, true);

  async.series([
    function(next) {
      self._connectWriterSocket(next);
    },
    function(next) {
      self._startListener(next);
    }
  ], function(err) {
    if (err) {
      return callback(err);
    }
    callback();
  });

};

WebWorker.prototype.stop = function(callback) {
  if (!this._stopping) {
    this._stopping = true;
    if (this.db) {
      db.close(this.db);
      setImmediate(callback);
    } else {
      setImmediate(callback);
    }
  }
};

WebWorker.prototype._initClients = function() {
  var clients = utils.getClients(this.clientsConfig);
  utils.setClients(this, clients);
};

WebWorker.prototype._connectWriterSocket = function(callback) {
  var self = this;

  this._writerCallbacks = {};

  this._writerSocket = net.connect({path: self.writerSocketPath}, function() {
    callback();
  });

  this._writerSocket.on('error', function(err) {
    console.error('Writer socket error:', err.stack);
  });

  var buffer = '';

  this._writerSocket.on('data', function(data) {

    buffer += data.toString('utf8');

    var msg;
    try {
      msg = JSON.parse(buffer);
      buffer = '';
    } catch(e) {
      return;
    }

    if (msg.id && self._writerCallbacks[msg.id]) {
      var error = null;
      if (msg.error) {
        error = new Error(msg.error.message);
      }
      self._writerCallbacks[msg.id](error, msg.result);
    }
  });
};

WebWorker.prototype._queueWriterTask = function(method, params, priority, callback) {
  var self = this;
  assert(Array.isArray(params), '"params" is expected to be an array');
  assert(_.isFunction(callback), '"callback" is expected to be a function');

  var taskId = utils.getTaskId();
  this._writerCallbacks[taskId] = callback;

  var msg = JSON.stringify({
    task: {
      id: taskId,
      method: method,
      params: params
    },
    priority: priority
  });

  self._writerSocket.write(msg, 'utf8', function(err) {
    if (err) {
      return console.error(err);
    }
  });
};

WebWorker.prototype._fromRawTransaction = function(txn, wallet, walletId, blockIndex, result) {
  var self = this;

  function isCoinbase(result) {
    if (result.vin[0] && result.vin[0].coinbase) {
      return true;
    }
    return false;
  }

  var tx = {
    blockHash: result.blockhash,
    blockIndex: blockIndex,
    height: result.height ? result.height : -1,
    blockTimestamp: result.time,
    version: result.version,
    hash: result.txid,
    locktime: result.locktime,
    inputSatoshis: 0,
    outputSatoshis: 0
  };

  if (isCoinbase(result)) {
    tx.coinbase = true;
  }

  function isWalletAddress(address) {
    // Will check the wallet bloom filter to see if it matches, and then verify that
    // it is part of the wallet.
    if (address && wallet.addressFilter.contains(bitcore.Address(address).hashBuffer)) {
      var walletAddress = models.WalletAddress(walletId, address);
      var buffer = txn.getBinary(self.db.addresses, walletAddress.getKey('hex'));
      if (buffer) {
        return true;
      }
    }
    return false;
  }

  function filterInput(input) {
    // Will apply following logic:
    // - checks if the input belongs to the wallet
    // - omits the scriptSig
    // - sums each input
    if (!input.coinbase) {
      assert(bitcore.util.js.isNaturalNumber(input.valueSat), 'input "valueSat" is expected to be number of satoshis');
      tx.inputSatoshis += input.valueSat;
    }
    return {
      wallet: isWalletAddress(input.address),
      satoshis: input.valueSat,
      address: input.address,
      prevTxId: input.txid || null,
      outputIndex: _.isUndefined(input.vout) ? null : input.vout,
      sequence: input.sequence
    };
  }

  function filterOutput(output) {
    // Will apply following logic:
    // - checks if the output belongs to the wallet
    // - omits extraneous scriptPubKey and spent information
    // - sums each output
    var script;
    var address;
    var wallet;
    if (output.scriptPubKey) {
      script = output.scriptPubKey.hex;
    }
    if (output.scriptPubKey && output.scriptPubKey.addresses && output.scriptPubKey.addresses.length === 1) {
      address = output.scriptPubKey.addresses[0];
      wallet = isWalletAddress(address);
    }
    assert(bitcore.util.js.isNaturalNumber(output.valueSat), 'output "valueSat" is expected to be number of satoshis');
    tx.outputSatoshis += output.valueSat;
    return {
      script: script,
      satoshis: output.valueSat,
      address: address,
      wallet: wallet
    };
  }

  tx.inputs = result.vin.map(filterInput);
  tx.outputs = result.vout.map(filterOutput);

  // Calculate the fee for this transation
  if (!tx.coinbase) {
    tx.feeSatoshis = tx.inputSatoshis - tx.outputSatoshis;
  } else {
    tx.feeSatoshis = 0;
  }

  return tx;
};

/* jshint maxparams: 5 */
WebWorker.prototype._importTransaction = function(txn, wallet, walletId, txidInfo, callback) {
  var self = this;

  var blockIndex = txidInfo[1];
  var txid = txidInfo[2];

  this.clients.getRawTransaction(txid.toString('hex'), 1, function(err, response) {
    if (err) {
      return callback(utils.wrapRPCError(err));
    }

    var transaction = self._fromRawTransaction(txn, wallet, walletId, blockIndex, response.result);

    // Only save the transaction locally if it is confirmed beyond safeConfirmations
    var confirmations = response.result.confirmations;
    if (confirmations > self.safeConfirmations) {
      self._queueWriterTask('saveTransaction', [walletId, transaction], 1 /* priority */, function(err) {
        if (err) {
          return callback(err);
        }
        callback(null, transaction);
      });
    } else {
      callback(null, transaction);
    }
  });
};

WebWorker.prototype.getWalletTransactions = function(walletId, options, callback) {
  var self = this;
  var txn = this.db.env.beginTxn({readOnly: true});

  var walletBuffer = txn.getBinary(this.db.wallets, walletId.toString('hex'));
  var wallet = models.Wallet.fromBuffer(walletId, walletBuffer);

  this._getLatestTxids(txn, walletId, options, function(err, result) {
    if (err) {
      txn.abort();
      return callback(err);
    }
    // TODO Using mapLimit or map here will cause concurrency isssue
    // that will halt when using _importTransaction
    async.mapSeries(result.txids, function(txidInfo, next) {
      var txid = txidInfo[2];
      var key = models.WalletTransaction.getKey(walletId, txid);
      var buffer = txn.getBinary(self.db.txs, key.toString('hex'));
      if (!buffer) {
        self._importTransaction(txn, wallet, walletId, txidInfo, function(err, tx) {
          next(err, tx);
        });
      } else {
        var tx = models.WalletTransaction.fromBuffer(walletId, buffer);
        next(null, tx.value);
      }
    }, function(err, transactions) {
      txn.abort();
      if (err) {
        return callback(err);
      }
      callback(null, {
        transactions: transactions,
        start: result.start,
        end: result.end
      });
    });
  });
};

var NULL_TXID = new Buffer(new Array(32));

WebWorker.prototype.getWalletUTXOs = function(walletId, options, callback) {
  var self = this;
  var txn = this.db.env.beginTxn({readOnly: true});

  var utxos = [];

  var cursor = new lmdb.Cursor(txn, this.db.utxos);

  var start = models.WalletUTXO.getKey(walletId, NULL_TXID, 0, 'hex');
  var found = cursor.goToRange(start);

  function iterator() {
    cursor.getCurrentBinary(function(key, value) {
      var utxo = models.WalletUTXO.fromBuffer(key, value, self.network);
      utxos.push(utxo);

      var nextFound = cursor.goToNext();
      if (nextFound && utxos.length < options.limit) {
        // TODO make sure maximum call stack is not reached
        iterator();
      } else {
        cursor.close();
        var result = {
          utxos: utxos
        };
        if (utxos.length === options.limit) {
          result.end = {}; // TODO
        }
        callback(null, result);
      }
    });
  }

  if (found) {
    iterator();
  } else {
    cursor.close();
    callback(null, {
      utxos: utxos
    });
  }

};

WebWorker.prototype._getLatestTxids = function(txn, walletId, options, callback) {
  var txids = [];

  try {
    options = validators.sanitizeRangeOptions(options);
  } catch(err) {
    return callback(err);
  }

  var cursor = new lmdb.Cursor(txn, this.db.txids);

  var start = models.WalletTxid.create(walletId, options.height, options.index);
  var found = cursor.goToRange(start.getKey().toString('hex'));
  if (!found) {
    found = cursor.goToPrev();
  }

  function iterator() {
    cursor.getCurrentBinary(function(key, value) {
      var parsedKey = models.WalletTxid.parseKey(key);
      txids.push([parsedKey.height, parsedKey.index, value]);

      var prevFound = cursor.goToPrev();
      if (prevFound && txids.length < options.limit) {
        // TODO make sure maximum call stack is not reached
        iterator();
      } else {
        cursor.close();
        // TODO include blockhash of start/tip height?
        var result = {
          txids: txids,
          start: {
            height: options.height,
            index: options.index
          }
        };
        // Only include "end" if there are more results
        if (txids.length === options.limit) {
          result.end = models.WalletTxid.parseKey(key);
        }
        callback(null, result);
      }
    });
  }

  if (found) {
    iterator();
  } else {
    cursor.close();
    callback(null, {
      txids: txids,
      start: {
        height: options.height,
        index: options.index
      }
    });
  }

};

WebWorker.prototype.getBalance = function(walletId, callback) {
  var txn = this.db.env.beginTxn({readOnly: true});
  var walletBuffer = txn.getBinary(this.db.wallets, walletId.toString('hex'));
  txn.abort();

  var wallet = models.Wallet.fromBuffer(walletId, walletBuffer);

  setImmediate(function() {
    callback(null, wallet.balance);
  });
};

/**
 * Will get the latest transaction ids for the wallet.
 * @param options
 * @param options.height - Starting block height
 * @param options.index - Starting block index
 * @param options.limit - Total number of txids to return
 */
WebWorker.prototype.getWalletTxids = function(walletId, options, callback) {
  var txn = this.db.env.beginTxn({readOnly: true});

  this._getLatestTxids(txn, walletId, options, function(err, result) {
    txn.abort();
    if (err) {
      return callback(err);
    }

    result.txids = result.txids.map(function(txidInfo) {
      return txidInfo[2].toString('hex');
    });

    callback(null, result);
  });

};

WebWorker.prototype._updateLatestTip = function() {
  var self = this;
  var txn = this.db.env.beginTxn({readOnly: true});

  var cursor = new lmdb.Cursor(txn, this.db.blocks);
  var found = cursor.goToLast();
  if (found) {
    cursor.getCurrentBinary(function(key, value) {
      var walletBlock = models.WalletBlock.fromBuffer(key, value);
      self.bitcoinHeight = walletBlock.height;
      self.bitcoinHash = walletBlock.blockHash.toString('hex');
      cursor.close();
      txn.abort();
    });
  } else {
    cursor.close();
    txn.abort();
    console.error(new Error('Unable to update tip'));
  }
};

WebWorker.prototype._startListener = function() {
  /* jshint maxstatements: 25 */

  var self = this;

  var app = express();

  // Include server bitcoin information for the request for middleware use
  app.use(function(req, res, next) {
    req.network = self.network;
    req.networkName = self.config.getNetworkName();

    self._updateLatestTip();

    req.bitcoinHeight = self.bitcoinHeight;
    req.bitcoinHash = self.bitcoinHash;
    next();
  });

  //Setup logging
  morgan.token('remote-forward-addr', function(req){
    return utils.getRemoteAddress(req);
  });
  var logFormat = ':remote-forward-addr ":method :url" :status :res[content-length] :response-time ":user-agent" ';
  var logStream = utils.createLogStream(function(data) {
    console.info(data.toString());
  });
  app.use(morgan(logFormat, {stream: logStream}));

  //Enable compression
  app.use(compression());

  //Enable body parsers
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({extended: true}));

  //Enable CORS
  app.use(utils.enableCORS);

  //Set bitcoin headers in the response
  app.use(function(req, res, next) {
    res.header('x-bitcoin-network', req.networkName);
    res.header('x-bitcoin-height', req.bitcoinHeight);
    res.header('x-bitcoin-hash', req.bitcoinHash);
    res.header('x-powered-by', 'bwsv2');
    next();
  });

  app.get('/info', function(req, res) {
    res.jsonp({
      version: version
    });
  });

  app.get('/wallets/:walletId/balance', validators.checkWalletId, function(req, res) {
    self.getBalance(req.walletId, function(err, balance) {
      if (err) {
        return utils.sendError(err, res);
      }
      res.jsonp({balance: balance});
    });
  });

  app.get('/wallets/:walletId/txids', validators.checkWalletId, validators.checkRangeParams, function(req, res) {
    self.getWalletTxids(req.walletId, req.range, function(err, txids) {
      if (err) {
        return utils.sendError(err, res);
      }
      res.jsonp(txids);
    });
  });

  app.get('/wallets/:walletId/transactions', validators.checkWalletId, validators.checkRangeParams, function(req, res) {
    self.getWalletTransactions(req.walletId, req.range, function(err, txs) {
      if (err) {
        return utils.sendError(err, res);
      }
      res.jsonp(txs);
    });
  });

  app.get('/wallets/:walletId/utxos', validators.checkWalletId, function(req, res) {
    var options = {
      limit: 10
    };
    self.getWalletUTXOs(req.walletId, options, function(err, utxos) {
      if (err) {
        return utils.sendError(err, res);
      }
      res.status(200).jsonp(utxos);
    });
  });

  app.put('/wallets/:walletId/addresses/:address', validators.checkWalletId, validators.checkAddress, function(req, res) {
    var addresses = [req.address];
    var walletId = req.walletId;
    self._queueWriterTask('importWalletAddresses', [walletId, addresses], 5 /* priority */, function(err, newAddresses) {
      if (err) {
        return utils.sendError(err, res);
      }
      if (!newAddresses.length) {
        return res.status(200).jsonp({
          address: req.address
        });
      }
      res.status(201).jsonp({
        address: req.address
      });
    });
  });

  app.post('/wallets/:walletId/addresses', validators.checkWalletId, validators.checkAddresses, function(req, res) {
    var addresses = req.addresses;
    var walletId = req.walletId;
    self._queueWriterTask('importWalletAddresses', [walletId, addresses], 10 /* priority */, function(err, newAddresses) {
      if (err) {
        return utils.sendError(err, res);
      }
      if (!newAddresses.length) {
        return res.status(204).end();
      }
      res.status(201).jsonp({
        addresses: newAddresses
      });
    });
  });

  app.put('/wallets/:walletId', validators.checkWalletId, function(req, res) {
    var params = [req.walletId];
    self._queueWriterTask('createWallet', params, 20, function(err, walletId) {
      if (err) {
        return utils.sendError(err, res);
      }
      if (!walletId) {
        return res.status(204).end();
      }
      res.status(201).jsonp({
        walletId: walletId
      });
    });
  });

  // Not Found
  app.use(function(req, res) {
    res.status(404).jsonp({
      status: 404,
      url: req.originalUrl,
      error: 'Not found'
    });
  });

  app.listen(this.port);

};

function masterMain() {
  function logStatus(worker, code, signal) {
    if (signal) {
      console.info('Web cluster worker ' + worker.id + ' was killed by signal: ' + signal);
    } else if (code !== 0) {
      console.info('Web cluster worker ' + worker.id + ' exited with code: ' + code);
    } else {
      console.info('Web cluster worker ' + worker.id + ' exited cleanly');
    }
  }

  function startWorker(worker) {
    worker.send({start: true});
    worker.on('error', function(err) {
      console.error('Web worker error:', err.stack);
    });
  }

  var workers = [];
  for (var i = 0; i < numCPUs; i++) {
    var workerProcess = cluster.fork();
    workers.push(workerProcess);
  }

  cluster.on('disconnect', function(worker) {
    console.log('Web cluster worker ' + worker.id + ' has disconnected');
  });

  cluster.on('exit', function(worker, code, signal) {
    if (worker.suicide !== true && (signal || code !== 0)) {
      logStatus(worker, code, signal);
      var newWorker = cluster.fork();
      var indexOfWorker = workers.indexOf(worker);
      if (indexOfWorker >= 0) {
        workers.splice(indexOfWorker, 1);
      }
      console.log('Web cluster worker respawned with worker id: ' + newWorker.id);
      workers.push(newWorker);
      startWorker(newWorker);
    } else {
      logStatus(worker, code, signal);
    }
  });

  workers.forEach(startWorker);

  process.on('SIGINT', function() {
    workers.forEach(function(worker) {
      if (worker.isConnected()) {
        worker.send({shutdown: true});
      }
    });
  });
}

function workerMain(workerOptions) {
  var EXIT_TIMEOUT = 5000;

  var worker = new WebWorker(workerOptions);
  var shuttingDown = false;

  function shutdown() {
    if (!shuttingDown) {
      shuttingDown = true;
      worker.stop(function(err) {
        if (err) {
          throw err;
        }
        process.exit(0);
      });

      setTimeout(function() {
        console.info('Web worker: could not close connections on time, forcefully shutting down');
        process.exit(0);
      }, EXIT_TIMEOUT);
    }
  }

  function start() {
    worker.start(function(err) {
      if (err) {
        throw err;
      }
    });
  }

  process.on('message', function(msg) {
    if (msg.start) {
      start();
    } else if (msg.shutdown) {
      shutdown();
    }
  });

  process.on('SIGINT', function() {
    shutdown();
  });

}

if (require.main === module) {

  var workerOptions = JSON.parse(process.argv[2]);

  if (cluster.isMaster) {
    process.title = 'bwdb-web-master';
    masterMain();
  } else {
    process.title = 'bwdb-web';
    workerMain(workerOptions);
  }

}

module.exports = WebWorker;
