import { describe, expect, it } from "vitest";
import { RELEASE_HEADER, releaseHeaders } from "./index";

const RELEASE = "9b3d37ed5c22";

describe("the release headers of a Worker", () => {
  it("declare the release, never cached, only with the switch exactly true", () => {
    expect(releaseHeaders(RELEASE, "true")).toEqual({
      "Cache-Control": "no-store",
      [RELEASE_HEADER]: RELEASE,
    });
  });

  it("are empty with the switch absent or any other value", () => {
    for (const enabled of [undefined, "", "false", "1", "TRUE", " true"]) {
      expect(releaseHeaders(RELEASE, enabled), String(enabled)).toEqual({});
    }
  });

  it("are empty for a release that is not 12 lowercase hex characters, even with the switch on", () => {
    for (const release of [
      "",
      "9b3d37ed5c2",
      "9b3d37ed5c223",
      "9B3D37ED5C22",
      "9b3d37ed5c2g",
      "9b3d37ed5c2\n",
    ]) {
      expect(releaseHeaders(release, "true"), release).toEqual({});
    }
  });
});
