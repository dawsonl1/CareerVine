/**
 * Action Items page - Task management interface
 * 
 * This page provides:
 * - List view of all pending action items
 * Separation of overdue vs upcoming tasks
 * Display of associated contact information
 * Due date tracking and prioritization
 * Task completion functionality (placeholder)
 * 
 * Action item features:
 * - Automatic overdue detection
 * - Contact association for context
 * - Due date sorting (earliest first)
 * - Visual distinction for overdue items
 * - Task descriptions and metadata
 */

"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { getActionItems } from "@/lib/queries";
import type { Database } from "@/lib/database.types";

// Type definition for ActionItem with contact data
// This matches what the getActionItems query returns with contact joins
type ActionItem = Database["public"]["Tables"]["follow_up_action_items"]["Row"] & {
  contacts: Database["public"]["Tables"]["contacts"]["Row"];
};

export default function ActionItemsPage() {
  // Get current authenticated user
  const { user } = useAuth();
  
  // Component state
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Load action items when component mounts or user changes
  useEffect(() => {
    if (user) {
      loadActionItems();
    }
  }, [user]);

  /**
   * Load all action items for the current user
   * Includes associated contact information via join
   */
  const loadActionItems = async () => {
    if (!user) return;
    try {
      const data = await getActionItems(user.id);
      setActionItems(data as ActionItem[]);
    } catch (error) {
      console.error("Error loading action items:", error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle task completion
   * 
   * Note: This is a placeholder implementation.
   * In a full implementation, this would call an updateActionItems
   * function to mark the task as completed in the database.
   * 
   * @param id - Action item ID to mark as complete
   */
  const toggleComplete = async (id: number) => {
    // TODO: Implement update action item mutation
    console.log("Toggle complete for action item:", id);
    
    // Placeholder implementation would look like:
    // await updateActionItem(id, { is_completed: true, completed_at: new Date().toISOString() });
    // await loadActionItems();
  };

  // Show loading state while fetching action items
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        <div className="p-8">Loading action items...</div>
      </div>
    );
  }

  // Separate overdue items from upcoming items
  const overdueItems = actionItems.filter(item => 
    item.due_at && new Date(item.due_at) < new Date()
  );

  const upcomingItems = actionItems.filter(item => 
    !item.due_at || new Date(item.due_at) >= new Date()
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation />
      <div className="p-8">
        {/* Page header */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold">Action Items</h1>
            <p className="text-gray-600 mt-1">
              Follow up on important tasks and commitments
            </p>
          </div>
        </div>

        {/* Overdue items section */}
        {overdueItems.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-red-600 mb-4">
              Overdue ({overdueItems.length})
            </h2>
            <div className="space-y-4">
              {overdueItems.map((item) => (
                <div key={item.id} className="bg-white p-6 rounded-lg shadow border-l-4 border-red-500">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      {/* Task title */}
                      <h3 className="text-lg font-semibold">{item.title}</h3>
                      
                      {/* Associated contact */}
                      <p className="text-gray-600 mb-2">
                        For: {item.contacts.name}
                      </p>
                      
                      {/* Task description */}
                      {item.description && (
                        <p className="text-gray-700 mb-2">{item.description}</p>
                      )}
                      
                      {/* Due date with overdue styling */}
                      <p className="text-sm text-red-600 font-medium">
                        Due: {item.due_at ? new Date(item.due_at).toLocaleDateString() : "No due date"}
                      </p>
                    </div>
                    
                    {/* Complete button */}
                    <button
                      onClick={() => toggleComplete(item.id)}
                      className="ml-4 px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                    >
                      Mark Complete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Upcoming items section */}
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Upcoming {upcomingItems.length > 0 && `(${upcomingItems.length})`}
          </h2>
          <div className="space-y-4">
            {upcomingItems.length === 0 ? (
              // Empty state when no upcoming items
              <div className="text-center py-12 bg-white rounded-lg shadow">
                <p className="text-gray-500">No pending action items</p>
                <p className="text-sm text-gray-400 mt-2">
                  Action items will appear here when you create them from meetings or contacts
                </p>
              </div>
            ) : (
              // List of upcoming action items
              upcomingItems.map((item) => (
                <div key={item.id} className="bg-white p-6 rounded-lg shadow">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      {/* Task title */}
                      <h3 className="text-lg font-semibold">{item.title}</h3>
                      
                      {/* Associated contact */}
                      <p className="text-gray-600 mb-2">
                        For: {item.contacts.name}
                      </p>
                      
                      {/* Task description */}
                      {item.description && (
                        <p className="text-gray-700 mb-2">{item.description}</p>
                      )}
                      
                      {/* Due date */}
                      <p className="text-sm text-gray-500">
                        {item.due_at 
                          ? `Due: ${new Date(item.due_at).toLocaleDateString()}`
                          : "No due date"
                        }
                      </p>
                    </div>
                    
                    {/* Complete button */}
                    <button
                      onClick={() => toggleComplete(item.id)}
                      className="ml-4 px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                    >
                      Mark Complete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
