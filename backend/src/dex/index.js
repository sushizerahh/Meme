'use strict';

const { Connection } = require('@solana/web3.js');
const config = require('../config/config');
const JupiterDex = require('./jupiter');
const RaydiumDex = require('./raydium');
const logger = require('../utils/logger');

let connection;
let jupiter;
let raydium;

function getConnection() {
  if (!connection) {
    const endpoints = config.solana.rpcEndpoints;
    // Use first healthy RPC; rotate on failure
    const endpoint = endpoints[0];
    connection = new Connection(endpoint, {
      commitment: config.solana.commitment,
      wsEndpoint: config.solana.wsEndpoint,
      confirmTransactionInitialTimeout: 30000,
    });
    logger.info('[DEX] Solana connection initialised', { endpoint });
  }
  return connection;
}

function rotateRpc() {
  const endpoints = config.solana.rpcEndpoints;
  if (endpoints.length < 2) return;
  endpoints.push(endpoints.shift()); // rotate
  connection = null; // force re-init on next getConnection()
  logger.warn('[DEX] Rotated RPC endpoint', { newEndpoint: endpoints[0] });
}

function getJupiter() {
  if (!jupiter) jupiter = new JupiterDex(getConnection());
  return jupiter;
}

function getRaydium() {
  if (!raydium) raydium = new RaydiumDex(getConnection());
  return raydium;
}

module.exports = { getConnection, getJupiter, getRaydium, rotateRpc };
