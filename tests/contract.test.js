const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");

function matches(source, expression, group = 1) {
  return [...source.matchAll(expression)].map((match) => match[group]);
}

test("application element ids exist and static ids are unique", () => {
  const htmlIds = matches(html, /\bid=["']([^"']+)["']/g);
  const referencedIds = matches(app, /getElementById\(["']([^"']+)["']\)/g);

  assert.equal(new Set(htmlIds).size, htmlIds.length, "index.html contains a duplicate id");
  referencedIds.forEach((id) => {
    assert.ok(htmlIds.includes(id), `app.js references missing #${id}`);
  });
});

test("timer-card node keys match template data roles", () => {
  const templateRoles = new Set(matches(html, /\bdata-role=["']([^"']+)["']/g));
  const namesBlock = app.match(/const names = \[([\s\S]*?)\];/);
  assert.ok(namesBlock, "collectCardNodes role list is missing");

  const collectedRoles = new Set(matches(namesBlock[1], /["']([^"']+)["']/g));
  collectedRoles.add("color");
  collectedRoles.forEach((name) => {
    assert.ok(templateRoles.has(name), `app.js collects missing data-role=${name}`);
  });

  const baseKeys = new Set(["card", "colors"]);
  matches(app, /\bnodes\.([A-Za-z][A-Za-z0-9]*)/g).forEach((key) => {
    assert.ok(
      baseKeys.has(key) || collectedRoles.has(key),
      `nodes.${key} is neither a collected role nor a base card key`
    );
  });
  matches(app, /\bnodes\[["']([^"']+)["']\]/g).forEach((key) => {
    assert.ok(collectedRoles.has(key), `nodes[${JSON.stringify(key)}] is not collected`);
  });
});

test("direct-open scripts remain classic deferred relative assets", () => {
  const scripts = matches(html, /<script\s+defer\s+src=["']([^"']+)["'][^>]*><\/script>/g);
  assert.deepEqual(scripts, [
    "js/storage.js",
    "js/timer.js",
    "js/audio.js",
    "js/app.js"
  ]);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["']/i);
});
