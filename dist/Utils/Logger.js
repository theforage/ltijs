"use strict";

// Pluggable logger for Ltijs internal logging.
//
// Historically every module logged through the `debug` package, which writes
// all output to stderr regardless of severity. Log aggregators (e.g. Datadog)
// then classify every line as an error. This module wraps `debug` so a host
// application can register its own logger via Provider.setup({ logger }) and
// receive structured entries with a derived severity level instead.

const createDebug = require('debug');
const util = require('util');
let customLogger = null;

// Keeps the original `.log` sink for every `debug` copy we patch, so the
// patch can be reverted and so we can fall back to it on errors.
const originalDebugLogs = new Map();

/**
 * @description Registers a custom logger sink. When set, Ltijs routes all
 * internal logging through it instead of writing to stderr via `debug`. It also
 * redirects the output of `debug` instances created by Ltijs's dependencies
 * (Ex: express, body-parser) so that every log produced while running Ltijs
 * flows through the same sink.
 * @param {Function|null} logger - Receives { namespace, level, message }.
 */
function setLogger(logger) {
  customLogger = typeof logger === 'function' ? logger : null;
  if (customLogger) {
    captureDependencyDebugOutput();
  } else {
    restoreDependencyDebugOutput();
  }
}

/**
 * @description Invokes `fn` once for each distinct `debug` factory currently
 * loaded in the module cache. Ltijs's dependencies may bundle their own copy of
 * `debug` (Ex: express ships debug@2), so there can be several factories, each
 * with its own default `.log` sink.
 */
function forEachDebugFactory(fn) {
  const seen = new Set();
  for (const id of Object.keys(require.cache)) {
    if (!/[\\/]node_modules[\\/]debug[\\/]/.test(id)) {
      continue;
    }
    const mod = require.cache[id];
    const factory = mod && mod.exports;
    // The debug factory is a function exposing `.enable`. Dedupe by identity
    // since a single package exposes the same factory from multiple files.
    if (typeof factory === 'function' && typeof factory.enable === 'function' && !seen.has(factory)) {
      seen.add(factory);
      fn(factory);
    }
  }
}

/**
 * @description Redirects the default output of every loaded `debug` copy to the
 * registered custom logger. Only namespaces already enabled via the `DEBUG`
 * environment variable produce output, so this captures exactly the lines that
 * would otherwise be written to stderr by Ltijs and its dependencies.
 */
function captureDependencyDebugOutput() {
  forEachDebugFactory(factory => {
    if (originalDebugLogs.has(factory)) {
      return;
    }
    originalDebugLogs.set(factory, factory.log);
    factory.log = function (...args) {
      const originalLog = originalDebugLogs.get(factory);
      if (!customLogger) {
        return originalLog ? originalLog.apply(this, args) : undefined;
      }
      try {
        customLogger({
          namespace: this && this.namespace || '',
          level: deriveLevel(args),
          message: util.format(...args)
        });
      } catch (err) {
        // Never let logging break the request flow.
        if (originalLog) {
          originalLog.apply(this, args);
        }
      }
    };
  });
}

/**
 * @description Restores the original `.log` sink on every patched `debug` copy.
 */
function restoreDependencyDebugOutput() {
  for (const [factory, originalLog] of originalDebugLogs) {
    factory.log = originalLog;
  }
  originalDebugLogs.clear();
}

/**
 * @description Derives a severity level from the logged arguments. Ltijs uses
 * `debug` for both traces and error reporting, so an Error argument is treated
 * as an error and everything else as a low-severity trace.
 */
function deriveLevel(args) {
  for (const arg of args) {
    if (arg instanceof Error) return 'error';
  }
  return 'debug';
}

/**
 * @description Logger factory. Returns a callable with the same signature as a
 * `debug` instance so existing call sites do not need to change.
 * @param {String} namespace - Debug namespace (Ex: 'provider:auth').
 */
function createLogger(namespace) {
  const debugInstance = createDebug(namespace);
  return (...args) => {
    if (!customLogger) {
      // Preserve original behavior when no custom logger is registered.
      return debugInstance(...args);
    }
    try {
      customLogger({
        namespace,
        level: deriveLevel(args),
        message: util.format(...args)
      });
    } catch (err) {
      // Never let logging break the request flow.
      debugInstance(...args);
    }
  };
}
module.exports = createLogger;
module.exports.setLogger = setLogger;