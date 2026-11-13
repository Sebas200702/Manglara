import { createBrowserRouter } from "react-router-dom";
import { App } from "./App";
import { NotFoundPage, RouteErrorPage, RouteLoading } from "./components/app-shell";
import { preloadAvatar } from "./components/app-shell/preload-avatar";

// Screens are lazy route modules so each route downloads only its own code
// (e.g. /conocimiento no longer pulls in three.js / TalkingHead).
export const router = createBrowserRouter([
  {
    element: <App />,
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <RouteLoading />,
    children: [
      {
        errorElement: <RouteErrorPage />,
        children: [
          {
            path: "/",
            lazy: async () => {
              preloadAvatar();
              return { Component: (await import("./screens/call-screen")).CallScreen };
            },
          },
          {
            path: "/reunion",
            lazy: async () => ({
              Component: (await import("./screens/meeting-screen")).MeetingScreen,
            }),
          },
          {
            path: "/conocimiento",
            lazy: async () => ({
              Component: (await import("./screens/knowledge")).KnowledgeScreen,
            }),
          },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
  {
    // Avatar-only page the meeting bot embeds as its camera (no app chrome).
    path: "/meeting/avatar",
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <RouteLoading />,
    lazy: async () => {
      preloadAvatar();
      return { Component: (await import("./screens/meeting-avatar")).MeetingAvatarPage };
    },
  },
]);
