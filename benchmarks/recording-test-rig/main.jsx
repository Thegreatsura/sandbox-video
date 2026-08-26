import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import ScreenRecordTestRig from "./screen-record-test-rig.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ScreenRecordTestRig />
  </StrictMode>,
);
