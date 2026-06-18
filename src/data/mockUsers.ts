import { User } from '../types';

// In-memory "database" of users
export const mockUsers: Map<number, User> = new Map([
  [1, { id: 1, name: 'John Doe',      email: 'john@example.com',  createdAt: '2024-01-01T00:00:00.000Z' }],
  [2, { id: 2, name: 'Jane Smith',    email: 'jane@example.com',  createdAt: '2024-01-02T00:00:00.000Z' }],
  [3, { id: 3, name: 'Alice Johnson', email: 'alice@example.com', createdAt: '2024-01-03T00:00:00.000Z' }],
]);

let nextId = 4;

/**
 * Simulates a database read with a 200ms delay.
 * Returns the user or null if not found.
 */
export async function fetchUserFromDB(id: number): Promise<User | null> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const user = mockUsers.get(id) ?? null;
      resolve(user);
    }, 200);
  });
}

/**
 * Simulates a database write with a short delay.
 * Assigns a new auto-incremented ID and persists in the in-memory store.
 */
export async function createUserInDB(data: { name: string; email: string }): Promise<User> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const user: User = {
        id: nextId++,
        name: data.name,
        email: data.email,
        createdAt: new Date().toISOString(),
      };
      mockUsers.set(user.id, user);
      resolve(user);
    }, 50);
  });
}
