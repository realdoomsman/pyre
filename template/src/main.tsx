import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PyreProvider } from "@pyre/app-sdk/react";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing <div id=\"root\">");

createRoot(root).render(
  <StrictMode>
    <PyreProvider>
      <App />
    </PyreProvider>
  </StrictMode>,
);
