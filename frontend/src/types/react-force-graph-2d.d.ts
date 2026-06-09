declare module 'react-force-graph-2d' {
  import { ComponentType } from 'react';

  interface ForceGraph2DProps {
    graphData: { nodes: any[]; links: any[] };
    nodeLabel?: string | ((node: any) => string);
    nodeColor?: string | ((node: any) => string);
    nodeVal?: number | ((node: any) => number);
    linkLabel?: string | ((link: any) => string);
    linkColor?: string | ((link: any) => string);
    linkDirectionalArrowLength?: number;
    linkDirectionalArrowRelPos?: number;
    nodeCanvasObject?: (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => void;
    width?: number;
    height?: number;
    backgroundColor?: string;
    [key: string]: any;
  }

  const ForceGraph2D: ComponentType<ForceGraph2DProps>;
  export default ForceGraph2D;
}
