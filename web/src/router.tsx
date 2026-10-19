import { createBrowserRouter } from "react-router-dom";
import { CallScreen } from "./screens/call-screen";
import { MeetingScreen } from "./screens/meeting-screen";
import { MeetingAvatarPage } from "./screens/meeting-avatar";
import { KnowledgeScreen } from "./screens/knowledge";
import { App } from "./App";

export const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      {
        path: "/",
        element: <CallScreen />,
      },
      {
        path: "/reunion",
        element: <MeetingScreen />,
      },
      {
        path: "/conocimiento",
        element: <KnowledgeScreen />,
      },
    ]
  },
  {
    // Avatar-only page the meeting bot embeds as its camera (no app chrome).
    path: "/meeting/avatar",
    element: <MeetingAvatarPage />,
  },
]);
