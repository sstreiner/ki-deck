"use strict";

// Drop-in replacement for deepmerge 4.3.1 (TehShrike/deepmerge, MIT), installed through
// package.json "overrides". Upstream has no release fixing CVE-2026-93753 / GHSA-gcqx-w48m-w2h4
// (the returned object can inherit an attacker-chosen prototype). Same public API:
// deepmerge(target, source, options) and deepmerge.all(objects, options). Differences: the keys
// __proto__, constructor and prototype are never copied, and values are written with
// defineProperty, so no prototype setter can run. Only @rollup/plugin-node-resolve uses it, at
// build time. Remove this override once deepmerge ships a fixed release.

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function isMergeableObject(value) {
  if (value === null || typeof value !== "object") return false;
  const tag = Object.prototype.toString.call(value);
  return tag !== "[object RegExp]" && tag !== "[object Date]" && value.$$typeof !== Symbol.for("react.element");
}

function emptyTarget(value) {
  return Array.isArray(value) ? [] : {};
}

function cloneUnlessOtherwiseSpecified(value, options) {
  return options.clone !== false && options.isMergeableObject(value) ? deepmerge(emptyTarget(value), value, options) : value;
}

function defaultArrayMerge(target, source, options) {
  return target.concat(source).map((element) => cloneUnlessOtherwiseSpecified(element, options));
}

function ownKeys(target) {
  const symbols = Object.getOwnPropertySymbols
    ? Object.getOwnPropertySymbols(target).filter((symbol) => Object.prototype.propertyIsEnumerable.call(target, symbol))
    : [];
  return Object.keys(target).concat(symbols).filter((key) => !FORBIDDEN.has(key));
}

function define(destination, key, value) {
  Object.defineProperty(destination, key, { value, writable: true, enumerable: true, configurable: true });
}

function mergerFor(key, options) {
  if (!options.customMerge) return deepmerge;
  const custom = options.customMerge(key);
  return typeof custom === "function" ? custom : deepmerge;
}

function mergeObject(target, source, options) {
  const destination = {};
  if (options.isMergeableObject(target)) {
    for (const key of ownKeys(target)) define(destination, key, cloneUnlessOtherwiseSpecified(target[key], options));
  }
  for (const key of ownKeys(source)) {
    const existing = Object.prototype.hasOwnProperty.call(target, key);
    if (existing && options.isMergeableObject(source[key])) {
      define(destination, key, mergerFor(key, options)(target[key], source[key], options));
    } else {
      define(destination, key, cloneUnlessOtherwiseSpecified(source[key], options));
    }
  }
  return destination;
}

function deepmerge(target, source, options) {
  options = Object.assign({}, options);
  options.arrayMerge = options.arrayMerge || defaultArrayMerge;
  options.isMergeableObject = options.isMergeableObject || isMergeableObject;
  // Exposed like upstream, so custom arrayMerge functions can clone elements.
  options.cloneUnlessOtherwiseSpecified = cloneUnlessOtherwiseSpecified;

  const sourceIsArray = Array.isArray(source);
  if (sourceIsArray !== Array.isArray(target)) return cloneUnlessOtherwiseSpecified(source, options);
  if (sourceIsArray) return options.arrayMerge(target, source, options);
  return mergeObject(target, source, options);
}

deepmerge.all = function all(array, options) {
  if (!Array.isArray(array)) throw new Error("first argument should be an array");
  return array.reduce((previous, next) => deepmerge(previous, next, options), {});
};

module.exports = deepmerge;
