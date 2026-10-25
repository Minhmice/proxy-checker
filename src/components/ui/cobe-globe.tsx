"use client";

import { useEffect, useRef, useState } from "react";
import createGlobe, { type Globe } from "cobe";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export interface GlobeMarker {
  location: [number, number]; // [lat, lng]
  size: number;
}

export interface CobeGlobeProps {
  markers?: GlobeMarker[];
  className?: string;
  size?: number;
}

export function CobeGlobe({ markers = [], className, size = 300 }: CobeGlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerInteracting = useRef<number | null>(null);
  const pointerInteractionMovement = useRef(0);
  const [hasWebGL, setHasWebGL] = useState(true);
  const isReduced = useReducedMotion();

  useEffect(() => {
    let phi = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Check WebGL availability
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) {
      setHasWebGL(false);
      return;
    }

    let globe: Globe | null = null;
    let isVisible = true;
    let rafId: number;

    // IntersectionObserver to pause rendering when offscreen
    const observer = new IntersectionObserver(([entry]) => {
      isVisible = entry.isIntersecting;
    });
    observer.observe(canvas);

    try {
      globe = createGlobe(canvas, {
        devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
        width: size * 2,
        height: size * 2,
        phi: 0,
        theta: 0.25,
        dark: 1,
        diffuse: 1.2,
        mapSamples: 12000,
        mapBrightness: 3.5,
        baseColor: [0.15, 0.2, 0.35],
        markerColor: [0.25, 0.65, 1],
        glowColor: [0.15, 0.25, 0.55],
        markers,
      });

      const render = () => {
        if (isVisible && globe) {
          if (!pointerInteracting.current && !isReduced) {
            phi += 0.004;
          }
          globe.update({
            phi: phi + pointerInteractionMovement.current,
          });
        }
        rafId = requestAnimationFrame(render);
      };
      rafId = requestAnimationFrame(render);
    } catch {
      setHasWebGL(false);
    }

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
      if (globe) {
        globe.destroy();
      }
    };
  }, [markers, size, isReduced]);

  if (!hasWebGL) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-full border border-border/60 bg-muted/20 font-mono text-xs text-muted-foreground",
          className,
        )}
        style={{ width: size, height: size }}
      >
        <span>Globe (WebGL unavailable)</span>
      </div>
    );
  }

  return (
    <div
      className={cn("relative mx-auto flex items-center justify-center overflow-hidden", className)}
      style={{ width: size, height: size }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          pointerInteracting.current = e.clientX - pointerInteractionMovement.current;
          if (canvasRef.current) canvasRef.current.style.cursor = "grabbing";
        }}
        onPointerUp={() => {
          pointerInteracting.current = null;
          if (canvasRef.current) canvasRef.current.style.cursor = "grab";
        }}
        onPointerOut={() => {
          pointerInteracting.current = null;
          if (canvasRef.current) canvasRef.current.style.cursor = "grab";
        }}
        onMouseMove={(e) => {
          if (pointerInteracting.current !== null) {
            const delta = e.clientX - pointerInteracting.current;
            pointerInteractionMovement.current = delta * 0.005;
          }
        }}
        onTouchMove={(e) => {
          if (pointerInteracting.current !== null && e.touches[0]) {
            const delta = e.touches[0].clientX - pointerInteracting.current;
            pointerInteractionMovement.current = delta * 0.005;
          }
        }}
        className="w-full h-full cursor-grab select-none opacity-90 hover:opacity-100 transition-opacity"
        style={{ width: size, height: size }}
      />
    </div>
  );
}
