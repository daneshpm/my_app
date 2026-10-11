import type { Example } from "./_examples.js";
import { createInspectCommand } from "./layout.js";

export const examples: Example[] = [
  ["Inspect visual layout across the current composition", "tagreel inspect"],
  ["Inspect a specific project", "tagreel inspect ./my-video"],
  ["Output agent-readable JSON", "tagreel inspect --json"],
  ["Use explicit hero-frame timestamps", "tagreel inspect --at 1.5,4.0,7.25"],
  [
    "Also sample at tween boundaries to catch transient overlaps",
    "tagreel inspect --at-transitions",
  ],
  [
    "Verify motion intent (add a *.motion.json sidecar next to the composition)",
    "tagreel inspect --json",
  ],
  ["Run the compatibility alias", "tagreel layout --json"],
];

export default createInspectCommand("inspect");
