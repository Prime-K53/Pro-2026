export const localFileStorage = {
  getUrl: async (_id: string): Promise<string | null> => null,
  getBlob: async (_id: string): Promise<Blob | null> => null,
  revoke: (_url: string) => {},
};
