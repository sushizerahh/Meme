'use strict';

const rpcManager = require('./rpcManager');
const jupiter    = require('./jupiter');
const RaydiumDex = require('./raydium');
const logger     = require('../utils/logger');

let raydium;

function getConnection() {
  return rpcManager.getConnection();
}

function getJupiter() {
  return jupiter;
}

function getRaydium() {
  if (!raydium) raydium = new RaydiumDex(rpcManager.getConnection());
  return raydium;
}

function rotateRpc() {
  rpcManager.rotateToNext();
  // Recreate Raydium with fresh connection
  raydium = null;
}

function startRpcManager() {
  rpcManager.start();
  logger.info('[DEX] RPC Manager started', {
    endpoints: rpcManager.getStats().map(e => e.url).join(', ')
  });
}

module.exports = { getConnection, getJupiter, getRaydium, rotateRpc, startRpcManager, rpcManager };
