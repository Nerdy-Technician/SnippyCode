import { Optional } from 'sequelize';
import { Model } from '.';

export interface User extends Model {
  email: string;
  displayName: string;
  passwordHash?: string | null;
  oidcSubject?: string | null;
  avatarPath?: string | null;
  isOwner: boolean;
  role: 'owner' | 'admin' | 'editor' | 'viewer' | 'user';
  mfaSecret?: string | null;
  mfaEnabled: boolean;
}

export interface UserCreationAttributes
  extends Optional<User, 'id' | 'createdAt' | 'updatedAt' | 'avatarPath' | 'oidcSubject' | 'passwordHash' | 'mfaSecret' | 'mfaEnabled' | 'role'> {}
