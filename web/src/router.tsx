import { createBrowserRouter } from "react-router-dom";
import { CallScreen } from "./screens/call-screen";
import { App } from "./App";

export const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      {
        path: "/",
        element: <CallScreen />,
      },
    ]
  }
]);
