declare namespace Express {
  interface Request {
    organization?: {
      id: string;
      name: string;
      slug: string;
      userRole: import('@prisma/client').OrgRole;
      userOrganizationId: string;
    };
    accessibleChannelIds?: 'ALL' | Set<string>;
  }
}
