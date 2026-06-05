export interface Tool {
  definition: {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
  };
  handler: (args: unknown) => Promise<{
    content: Array<{
      type: string;
      text: string;
    }>;
  }>;
}