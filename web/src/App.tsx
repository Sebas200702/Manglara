import { Outlet } from "react-router-dom";
import { OfflineBanner } from "./components/app-shell";

export function App() {
  return (
    <div>
      <OfflineBanner />
      <Outlet />
    </div>
  );
}
