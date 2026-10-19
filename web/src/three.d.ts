declare module "three" {
  export class CanvasTexture {
    constructor(canvas: HTMLCanvasElement);
    colorSpace: string;
    flipY: boolean;
    needsUpdate: boolean;
    [key: string]: any;
  }

  export class MeshBasicMaterial {
    constructor(parameters?: {
      map?: any;
      transparent?: boolean;
      depthWrite?: boolean;
      [key: string]: any;
    });
    [key: string]: any;
  }

  export const SRGBColorSpace: string;

  export class Mesh {
    isMesh: boolean;
    name: string;
    material: any;
    renderOrder: number;
    traverse(callback: (object: any) => void): void;
    [key: string]: any;
  }
}
