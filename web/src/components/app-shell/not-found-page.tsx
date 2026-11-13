import { Compass, Home } from "lucide-react";
import { Link } from "react-router-dom";
import { primaryButton, StatusPage } from "./status-page";

/** Spanish 404 page for unknown routes. */
export function NotFoundPage() {
  return (
    <StatusPage
      icon={<Compass className="size-10" />}
      title="No encontramos esta página"
      description="Puede que el enlace esté mal escrito o que la página ya no exista."
      actions={
        <Link to="/" className={primaryButton}>
          <Home className="size-4" aria-hidden />
          Ir al inicio
        </Link>
      }
    />
  );
}
