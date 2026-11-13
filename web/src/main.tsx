import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { initErrorTracking, rootErrorHandlers } from "./lib/error-tracking";
import { router } from "./router";
import "./styles/global.css";

initErrorTracking();

createRoot(document.getElementById("root")!, rootErrorHandlers).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
