import assert from "node:assert/strict";
import test from "node:test";

import { parseUploadsPublication } from "../src/uploads.js";

const key = "screenshots/sandbox-video/test/proof.mp4";

test("accepts an exact HTTPS uploads publication", () => {
  assert.deepEqual(
    parseUploadsPublication(
      JSON.stringify({
        key,
        url: `https://storage.uploads.sh/curtis-arch/${key}`,
        size: 42,
      }),
      key,
      42,
    ),
    {
      key,
      url: `https://storage.uploads.sh/curtis-arch/${key}`,
      contentType: "video/mp4",
      sizeBytes: 42,
    },
  );
});

test("rejects a publication for a different object or contradictory size", () => {
  assert.throws(
    () =>
      parseUploadsPublication(
        JSON.stringify({ key: `${key}.other`, url: "https://storage.uploads.sh/x", size: 42 }),
        key,
        42,
      ),
    /different storage key/u,
  );
  assert.throws(
    () =>
      parseUploadsPublication(
        JSON.stringify({ key, url: "https://storage.uploads.sh/x", size: 41 }),
        key,
        42,
      ),
    /unexpected file size/u,
  );
});

test("accepts omitted or null advisory size fields", () => {
  for (const fields of [{}, { size: null }, { sizeBytes: null }]) {
    const publication = parseUploadsPublication(
      JSON.stringify({ key, url: "https://storage.uploads.sh/x", ...fields }),
      key,
      42,
    );
    assert.equal(publication.sizeBytes, 42);
  }
});

test("rejects a non-HTTPS publication URL", () => {
  assert.throws(
    () =>
      parseUploadsPublication(
        JSON.stringify({ key, url: "http://storage.uploads.sh/x", size: 42 }),
        key,
        42,
      ),
    /non-public URL/u,
  );
});
