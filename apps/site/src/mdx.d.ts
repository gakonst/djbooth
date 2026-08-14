import type { ComponentType } from "react";

declare module "*.mdx" {
  export const metadata: {
    title: string;
    description: string;
    publishedAt: string;
    topic: "Agents" | "Audio engineering" | "Reverse engineering" | "Performance";
    tags: string[];
    featured?: boolean;
    readingTime: string;
  };
  const Content: ComponentType;
  export default Content;
}
