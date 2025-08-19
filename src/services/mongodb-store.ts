import { DocumentUpdate, DocumentCommit } from "../types/index";
import { DocumentUpdateModel, DocumentCommitModel } from "../database/models";

export class MongoDBStore {
  // Update management
  async createUpdate(update: DocumentUpdate): Promise<DocumentUpdate> {
    try {
      const mongoUpdate = new DocumentUpdateModel({
        _id: update.id,
        document_id: update.document_id,
        user_id: update.user_id,
        data: update.data,
        update_type: update.update_type,
        committed: update.committed,
        commit_cid: update.commit_cid,
        created_at: update.created_at,
      });

      await mongoUpdate.save();
      return update;
    } catch (error) {
      console.error("Error creating update:", error);
      throw error;
    }
  }

  async getUpdate(updateId: string): Promise<DocumentUpdate | undefined> {
    try {
      const update = await DocumentUpdateModel.findById(updateId);
      if (!update) return undefined;

      return {
        id: update._id,
        document_id: update.document_id,
        user_id: update.user_id,
        data: update.data,
        update_type: update.update_type,
        committed: update.committed,
        commit_cid: update.commit_cid,
        created_at: update.created_at,
      };
    } catch (error) {
      console.error("Error getting update:", error);
      return undefined;
    }
  }

  async getUpdatesByDocument(
    documentId: string,
    options: {
      limit?: number;
      offset?: number;
      committed?: boolean;
      sort?: "asc" | "desc";
    } = {}
  ): Promise<DocumentUpdate[]> {
    try {
      let query = DocumentUpdateModel.find({ document_id: documentId });

      // Filter by committed status
      if (options.committed !== undefined) {
        query = query.where({ committed: options.committed });
      }

      // Sort by creation time
      const sortOrder = options.sort === "desc" ? -1 : 1;
      query = query.sort({ created_at: sortOrder });

      // Apply pagination
      if (options.offset) {
        query = query.skip(options.offset);
      }
      if (options.limit) {
        query = query.limit(options.limit);
      }

      const updates = await query.exec();

      return updates.map((update) => ({
        id: update._id,
        document_id: update.document_id,
        user_id: update.user_id,
        data: update.data,
        update_type: update.update_type,
        committed: update.committed,
        commit_cid: update.commit_cid,
        created_at: update.created_at,
      }));
    } catch (error) {
      console.error("Error getting updates by document:", error);
      return [];
    }
  }

  async markUpdatesAsCommitted(updateIds: string[], commitId: string) {
    try {
      await DocumentUpdateModel.updateMany(
        { _id: { $in: updateIds } },
        {
          committed: true,
          commit_cid: commitId,
        }
      );
    } catch (error) {
      console.error("Error marking updates as committed:", error);
      throw error;
    }
  }

  // Commit management
  async createCommit(commit: DocumentCommit): Promise<DocumentCommit> {
    try {
      const mongoCommit = new DocumentCommitModel({
        _id: commit.id,
        document_id: commit.document_id,
        user_id: commit.user_id,
        cid: commit.cid,
        data: commit.data,
        updates: commit.updates,
        created_at: commit.created_at,
      });

      await mongoCommit.save();

      // Mark associated updates as committed
      await this.markUpdatesAsCommitted(commit.updates, commit.cid);

      return commit;
    } catch (error) {
      console.error("Error creating commit:", error);
      throw error;
    }
  }

  async getCommit(commitId: string): Promise<DocumentCommit | undefined> {
    try {
      const commit = await DocumentCommitModel.findById(commitId);
      if (!commit) return undefined;

      return {
        id: commit._id,
        document_id: commit.document_id,
        user_id: commit.user_id,
        cid: commit.cid,
        data: commit.data,
        updates: commit.updates,
        created_at: commit.created_at,
      };
    } catch (error) {
      console.error("Error getting commit:", error);
      return undefined;
    }
  }

  async getCommitsByDocument(
    documentId: string,
    options: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    } = {}
  ): Promise<DocumentCommit[]> {
    try {
      let query = DocumentCommitModel.find({ document_id: documentId });

      // Sort by creation time
      const sortOrder = options.sort === "desc" ? -1 : 1;
      query = query.sort({ created_at: sortOrder });

      // Apply pagination
      if (options.offset) {
        query = query.skip(options.offset);
      }
      if (options.limit) {
        query = query.limit(options.limit);
      }

      const commits = await query.exec();

      return commits.map((commit) => ({
        id: commit._id,
        document_id: commit.document_id,
        user_id: commit.user_id,
        cid: commit.cid,
        data: commit.data,
        updates: commit.updates,
        created_at: commit.created_at,
      }));
    } catch (error) {
      console.error("Error getting commits by document:", error);
      return [];
    }
  }

  // Room member management
  // async getRoomMembers(documentId: string): Promise<RoomMember[]> {
  //   try {
  //     const members = await RoomMemberModel.find({ document_id: documentId });
  //     return members.map((member) => ({
  //       user_id: member.user_id,
  //       username: member.username,
  //       role: member.role,
  //       client_id: member.client_id,
  //       joined_at: member.joined_at,
  //     }));
  //   } catch (error) {
  //     console.error("Error getting room members:", error);
  //     return [];
  //   }
  // }

  // async addRoomMember(documentId: string, member: RoomMember) {
  //   try {
  //     await RoomMemberModel.findOneAndUpdate(
  //       { document_id: documentId, user_id: member.user_id },
  //       {
  //         username: member.username,
  //         role: member.role,
  //         client_id: member.client_id,
  //         joined_at: member.joined_at,
  //       },
  //       { upsert: true, new: true }
  //     );
  //   } catch (error) {
  //     console.error("Error adding room member:", error);
  //     throw error;
  //   }
  // }

  // async removeRoomMember(documentId: string, userId: string) {
  //   try {
  //     await RoomMemberModel.deleteOne({
  //       document_id: documentId,
  //       user_id: userId,
  //     });
  //   } catch (error) {
  //     console.error("Error removing room member:", error);
  //     throw error;
  //   }
  // }

  // async getRoomMember(documentId: string, userId: string): Promise<RoomMember | undefined> {
  //   try {
  //     const member = await RoomMemberModel.findOne({
  //       document_id: documentId,
  //       user_id: userId,
  //     });

  //     if (!member) return undefined;

  //     return {
  //       user_id: member.user_id,
  //       username: member.username,
  //       role: member.role,
  //       client_id: member.client_id,
  //       joined_at: member.joined_at,
  //     };
  //   } catch (error) {
  //     console.error("Error getting room member:", error);
  //     return undefined;
  //   }
  // }

  // Statistics
  async getStats() {
    try {
      const [updates, commits] = await Promise.all([
        DocumentUpdateModel.countDocuments(),
        DocumentCommitModel.countDocuments(),
      ]);

      return {
        updates,
        commits,
      };
    } catch (error) {
      console.error("Error getting stats:", error);
      return {
        updates: 0,
        commits: 0,
      };
    }
  }

  // Clear all data (useful for testing)
  async clear() {
    try {
      await Promise.all([DocumentUpdateModel.deleteMany({}), DocumentCommitModel.deleteMany({})]);
    } catch (error) {
      console.error("Error clearing data:", error);
      throw error;
    }
  }
}

export const mongodbStore = new MongoDBStore();
