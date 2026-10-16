"""Registro de recetas por proveedor."""

from .base import JoinRecipe
from .meet import MeetRecipe
from .teams import TeamsRecipe
from .zoom import ZoomRecipe

_RECIPES: dict[str, JoinRecipe] = {
    "teams": TeamsRecipe(),
    "zoom": ZoomRecipe(),
    "meet": MeetRecipe(),
}


def get_recipe(provider: str) -> JoinRecipe:
    try:
        return _RECIPES[provider]
    except KeyError:
        raise ValueError(f"Proveedor no soportado: {provider}")


__all__ = ["JoinRecipe", "get_recipe"]
