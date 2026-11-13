import { AlertTriangle, Home, RotateCw } from "lucide-react";
import { useEffect } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { NotFoundPage } from "./not-found-page";
import { primaryButton, secondaryButton, StatusPage } from "./status-page";

/**
 * Router `errorElement`: replaces react-router's default (English) error
 * screen. Also catches failed lazy-route chunk loads (e.g. after a deploy
 * replaced the hashed assets), where reloading is the fix.
 */
export function RouteErrorPage() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  useEffect(() => {
    if (!notFound) console.error("[route-error]", error);
  }, [error, notFound]);

  if (notFound) return <NotFoundPage />;

  return (
    <StatusPage
      icon={<AlertTriangle className="size-10 text-status-error" />}
      title="Algo salió mal"
      description="Tuvimos un problema al mostrar esta página. Recárgala para intentarlo de nuevo."
      actions={
        <>
          <button type="button" className={primaryButton} onClick={() => window.location.reload()}>
            <RotateCw className="size-4" aria-hidden />
            Recargar página
          </button>
          {/* Full navigation (not <Link>) so a broken in-memory state is discarded. */}
          <a href="/" className={secondaryButton}>
            <Home className="size-4" aria-hidden />
            Ir al inicio
          </a>
        </>
      }
    />
  );
}
