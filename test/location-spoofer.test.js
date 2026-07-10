"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const api = require("../location-spoofer.js");
const qx = require("../location-spoofer-qx.js");

const U = (values) => Uint8Array.from(values);
const eq = (actual, expected) => assert.deepEqual([...actual], [...expected]);
const key = (fieldNumber, wireType) =>
  api.encodeVarintUnsigned((BigInt(fieldNumber) << 3n) | BigInt(wireType));
const rawVarint = (fieldNumber, valueBytes) =>
  api.concatBytes([key(fieldNumber, 0), U(valueBytes)]);
const rawLengthDelimited = (fieldNumber, payload, lengthBytes) =>
  api.concatBytes([
    key(fieldNumber, 2),
    lengthBytes || api.encodeVarintUnsigned(payload.length),
    payload
  ]);
const rawFixed32 = (fieldNumber, bytes) =>
  api.concatBytes([key(fieldNumber, 5), U(bytes)]);

function config(extra) {
  return api.normalizeConfig({
    ...api.DEFAULT_CONFIG,
    latitude: -12.34567891,
    longitude: 98.76543219,
    metadataMode: "preserve",
    ...extra
  });
}

function findField(fields, fieldNumber, wireType) {
  return fields.find(
    (field) =>
      field.fieldNumber === fieldNumber &&
      (wireType == null || field.wireType === wireType)
  );
}

test("preserve mode changes only coordinate varints", () => {
  const cfg = config();
  const accuracy = rawVarint(3, [0x81, 0x00]);
  const oldLatitude = api.makeVarintField(1, 111);
  const unknown = rawLengthDelimited(40, U([0xde, 0xad]), U([0x82, 0x00]));
  const oldLongitude = api.makeVarintField(2, -222);
  const fixed = rawFixed32(50, [1, 2, 3, 4]);
  const input = api.concatBytes([
    accuracy,
    oldLatitude,
    unknown,
    oldLongitude,
    fixed
  ]);
  const expected = api.concatBytes([
    accuracy,
    api.makeVarintField(1, api.coordToInt(cfg.latitude)),
    unknown,
    api.makeVarintField(2, api.coordToInt(cfg.longitude)),
    fixed
  ]);

  eq(api.patchLocation(input, cfg), expected);
});

test("preserve mode retains unexpected coordinate wire types and injects valid coordinates", () => {
  const cfg = config();
  const wrongLatitude = rawLengthDelimited(1, U([0xaa]));
  const wrongLongitude = rawFixed32(2, [1, 2, 3, 4]);
  const metadata = rawVarint(3, [7]);
  const input = api.concatBytes([wrongLatitude, wrongLongitude, metadata]);
  const expected = api.concatBytes([
    wrongLatitude,
    wrongLongitude,
    metadata,
    api.makeVarintField(1, api.coordToInt(cfg.latitude)),
    api.makeVarintField(2, api.coordToInt(cfg.longitude))
  ]);

  eq(api.patchLocation(input, cfg), expected);
});

test("root, Wi-Fi, cell and unknown fields are preserved in both script implementations", () => {
  const cfg = config();
  const location = api.concatBytes([
    rawVarint(3, [0x81, 0x00]),
    api.makeVarintField(1, 111),
    rawLengthDelimited(44, U([9, 8, 7])),
    api.makeVarintField(2, 222)
  ]);
  const wifi = api.concatBytes([
    rawLengthDelimited(1, U([1, 2, 3, 4, 5, 6])),
    api.makeLengthDelimitedField(2, location),
    rawFixed32(77, [5, 6, 7, 8])
  ]);
  const cell = api.concatBytes([
    rawVarint(1, [1]),
    api.makeLengthDelimitedField(5, location),
    rawLengthDelimited(60, U([0xca, 0xfe]))
  ]);
  const root3 = rawVarint(3, [0x81, 0x00]);
  const root4 = rawVarint(4, [0x82, 0x00]);
  const root33 = rawLengthDelimited(33, U([0x69, 0x4f, 0x53]));
  const root99 = rawFixed32(99, [9, 9, 9, 9]);
  const root = api.concatBytes([
    root3,
    api.makeLengthDelimitedField(2, wifi),
    root4,
    root33,
    api.makeLengthDelimitedField(22, cell),
    root99,
    api.makeLengthDelimitedField(24, cell)
  ]);

  const mainResult = api.patchAppleWLocPayload(root, cfg);
  const qxResult = qx.patchAppleWLocPayload(root, cfg);
  eq(qxResult.payload, mainResult.payload);
  assert.equal(mainResult.wifiCount, 1);
  assert.equal(mainResult.cellCount, 2);

  const outputFields = api.parseFields(mainResult.payload);
  eq(findField(outputFields, 3).raw, root3);
  eq(findField(outputFields, 4).raw, root4);
  eq(findField(outputFields, 33).raw, root33);
  eq(findField(outputFields, 99).raw, root99);

  const wifiLocation = findField(
    api.parseFields(findField(outputFields, 2, 2).valueBytes),
    2,
    2
  );
  const patchedLocationFields = api.parseFields(wifiLocation.valueBytes);
  eq(findField(patchedLocationFields, 3).raw, rawVarint(3, [0x81, 0x00]));
  eq(findField(patchedLocationFields, 44).raw, rawLengthDelimited(44, U([9, 8, 7])));
});

test("legacy mode remains available for existing metadata-rewrite users", () => {
  const cfg = config({ metadataMode: "legacy" });
  const location = api.concatBytes([
    api.makeVarintField(1, 111),
    api.makeVarintField(2, 222),
    api.makeVarintField(3, 999)
  ]);
  const root = api.concatBytes([
    api.makeVarintField(3, 1),
    api.makeLengthDelimitedField(
      2,
      api.makeLengthDelimitedField(2, location)
    ),
    api.makeVarintField(4, 1),
    rawLengthDelimited(33, U([1]))
  ]);

  const result = api.patchAppleWLocPayload(root, cfg);
  const rootFields = api.parseFields(result.payload);
  assert.equal(findField(rootFields, 3), undefined);
  assert.equal(findField(rootFields, 4), undefined);
  assert.equal(findField(rootFields, 33), undefined);
});

test("request-side synthetic response uses preserved request metadata", () => {
  const cfg = config();
  const metadata = rawLengthDelimited(88, U([4, 3, 2, 1]));
  const root = api.concatBytes([
    metadata,
    api.makeLengthDelimitedField(
      2,
      api.makeLengthDelimitedField(
        2,
        api.concatBytes([
          api.makeVarintField(1, 1),
          api.makeVarintField(2, 2),
          rawVarint(3, [0x81, 0x00])
        ])
      )
    )
  ]);
  const request = api.serializeArpc({
    version: 1,
    locale: "en_US",
    appIdentifier: "com.apple.locationd",
    osVersion: "27.0",
    functionId: 1,
    payload: root
  });

  const result = api.spoofArpcRequest(request, cfg);
  const extraction = api.extractAppleWLocPayload(result.response);
  eq(findField(api.parseFields(extraction.payload), 88).raw, metadata);
  assert.equal(extraction.kind, "synthetic");
});

test("Shadowrocket request mode is reachable and returns a local HTTP 200 response", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "location-spoofer.js"),
    "utf8"
  );
  const root = api.makeLengthDelimitedField(
    2,
    api.makeLengthDelimitedField(
      2,
      api.concatBytes([
        api.makeVarintField(1, 1),
        api.makeVarintField(2, 2),
        api.makeVarintField(3, 39)
      ])
    )
  );
  const requestBody = api.serializeArpc({
    version: 1,
    locale: "en_US",
    appIdentifier: "com.apple.locationd",
    osVersion: "27.0",
    functionId: 1,
    payload: root
  });
  let completed;
  vm.runInNewContext(source, {
    $request: {
      url: "https://gs-loc.apple.com/clls/wloc",
      headers: {},
      body: requestBody
    },
    $argument: "mode=request&metadataMode=preserve&latitude=1.25&longitude=2.5",
    $done: (value) => {
      completed = value;
    },
    console,
    Uint8Array,
    ArrayBuffer,
    BigInt,
    Buffer,
    setTimeout,
    clearTimeout
  });

  assert.equal(completed.response.status, 200);
  assert.equal(completed.response.headers["Content-Type"], "application/octet-stream");
  assert.ok(completed.response.body.length > 10);
});

test("HTTP errors are passed through instead of being parsed as protobuf", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "location-spoofer.js"),
    "utf8"
  );
  let completed;
  vm.runInNewContext(source, {
    $request: { url: "https://gs-loc.apple.com/clls/wloc", headers: {} },
    $response: { status: "HTTP/1.1 400 Bad Request", headers: { "Content-Type": "text/plain" }, body: "Bad Request" },
    $argument: "mode=response&metadataMode=preserve",
    $done: (value) => {
      completed = value;
    },
    console,
    Uint8Array,
    ArrayBuffer,
    BigInt,
    Buffer,
    setTimeout,
    clearTimeout
  });

  assert.equal(Object.keys(completed).length, 0);
});

test("request mode fails open when the ARPC request is malformed", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "location-spoofer.js"),
    "utf8"
  );
  let completed;
  vm.runInNewContext(source, {
    $request: {
      url: "https://gs-loc.apple.com/clls/wloc",
      headers: {},
      body: U([0xff, 0xff, 0xff])
    },
    $argument: "mode=request&metadataMode=preserve",
    $done: (value) => {
      completed = value;
    },
    console,
    Uint8Array,
    ArrayBuffer,
    BigInt,
    Buffer,
    setTimeout,
    clearTimeout
  });

  assert.equal(Object.keys(completed).length, 0);
});

test("disabled request mode passes the request through without synthesizing a response", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "location-spoofer.js"),
    "utf8"
  );
  let completed;
  vm.runInNewContext(source, {
    $request: {
      url: "https://gs-loc.apple.com/clls/wloc",
      headers: {}
    },
    $argument: "mode=request&enabled=false&metadataMode=preserve",
    $done: (value) => {
      completed = value;
    },
    console,
    Uint8Array,
    ArrayBuffer,
    BigInt,
    Buffer,
    setTimeout,
    clearTimeout
  });

  assert.equal(Object.keys(completed).length, 0);
});
