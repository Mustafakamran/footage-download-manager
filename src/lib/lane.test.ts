import { describe, it, expect } from "vitest";
import { laneOf } from "./lane";

describe("laneOf", () => {
  it("classifies each primary prefix as primary", () => {
    expect(laneOf("drive_x")).toBe("primary");
    expect(laneOf("drivelink_abc")).toBe("primary");
    expect(laneOf("dropbox_y")).toBe("primary");
    expect(laneOf("dropboxlink_z")).toBe("primary");
  });

  it("treats bare prefixes (no separator) as primary", () => {
    expect(laneOf("drive")).toBe("primary");
    expect(laneOf("dropbox")).toBe("primary");
    expect(laneOf("drivelink")).toBe("primary");
    expect(laneOf("dropboxlink")).toBe("primary");
  });

  it("classifies http as secondary", () => {
    expect(laneOf("http")).toBe("secondary");
  });

  it("classifies ytdlp (browser-captured media) as secondary", () => {
    expect(laneOf("ytdlp")).toBe("secondary");
  });

  it("classifies unknown ids as secondary", () => {
    expect(laneOf("torrent_1")).toBe("secondary");
    expect(laneOf("")).toBe("secondary");
    expect(laneOf("something-else")).toBe("secondary");
  });
});
