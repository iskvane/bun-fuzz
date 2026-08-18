/**
 * Pixel-art stage that stands in for the entrance mask once you're in a
 * room. Layered SVGs (see pixelband/README.md for the coordinate
 * convention): backdrop, one image per role switched between its "normal"
 * and "silhouette" variant depending on whether a player currently holds
 * that seat, then the foreground instruments on top – so drummer and
 * keyboarder stand visibly behind their gear.
 */

import { ROLES, ROLE_LABEL, type Role, type RoomState } from "../shared/protocol";

import stage from "./pixelband/buehne-basis.svg";
import foreground from "./pixelband/instrumente-vorne.svg";
import bassNormal from "./pixelband/bass-normal.svg";
import bassSilhouette from "./pixelband/bass-silhouette.svg";
import guitarNormal from "./pixelband/gitarre-normal.svg";
import guitarSilhouette from "./pixelband/gitarre-silhouette.svg";
import keysNormal from "./pixelband/keyboard-normal.svg";
import keysSilhouette from "./pixelband/keyboard-silhouette.svg";
import drumsNormal from "./pixelband/schlagzeug-normal.svg";
import drumsSilhouette from "./pixelband/schlagzeug-silhouette.svg";

const VARIANTS: Record<Role, { normal: string; silhouette: string }> = {
  guitar: { normal: guitarNormal, silhouette: guitarSilhouette },
  bass: { normal: bassNormal, silhouette: bassSilhouette },
  drums: { normal: drumsNormal, silhouette: drumsSilhouette },
  keys: { normal: keysNormal, silhouette: keysSilhouette },
};

export class PixelBand {
  readonly el: HTMLElement;
  private readonly layers = new Map<Role, HTMLImageElement>();

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pixel-band";
    this.el.setAttribute("aria-label", "Pixel band on stage");

    const base = document.createElement("img");
    base.className = "layer";
    base.src = stage;
    base.alt = "";
    this.el.append(base);

    for (const role of ROLES) {
      const img = document.createElement("img");
      img.className = "layer";
      img.alt = `${ROLE_LABEL[role]}, free`;
      img.src = VARIANTS[role].silhouette;
      this.el.append(img);
      this.layers.set(role, img);
    }

    const front = document.createElement("img");
    front.className = "layer";
    front.src = foreground;
    front.alt = "";
    this.el.append(front);
  }

  update(state: RoomState): void {
    for (const role of ROLES) {
      const img = this.layers.get(role)!;
      const holder = state.players.find((p) => p.seat === role);
      img.src = holder ? VARIANTS[role].normal : VARIANTS[role].silhouette;
      img.alt = holder ? `${ROLE_LABEL[role]}: ${holder.name}` : `${ROLE_LABEL[role]}, free`;
    }
  }
}
