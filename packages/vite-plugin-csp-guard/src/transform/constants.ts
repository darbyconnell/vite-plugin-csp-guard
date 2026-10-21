import { DevOptions, DevOutlier } from "../types";

export const REQUIRE_POST_TRANSFORM: Array<DevOutlier> = [
  "tailwind",
  "sass",
  "less",
  "stylus",
  "vue",
];

export const DEFAULT_DEV_OPTIONS: DevOptions = {
  run: false,
  outlierSupport: [],
};
