/**
 * Interactions page - Contact-specific interaction tracking
 * 
 * This page provides:
 * - List view of all interactions with a specific contact
 * - Create new interactions with date, type, and summary
 * - Chronological ordering (most recent first)
 * - Modal forms for interaction creation
 * - Empty state handling
 * 
 * Interaction features:
 * - Multiple interaction types (email, phone, coffee, etc.)
 * - Contact association via props or URL params
 * - Summary notes for each interaction
 * - Historical tracking of touchpoints
 * 
 * Note: This page is designed to be accessed from a contact's detail page
 * with contactId and contactName props passed down.
 */

"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import { getInteractions, createInteraction } from "@/lib/queries";
import type { Database } from "@/lib/database.types";

// Type definition for Interaction
type Interaction = Database["public"]["Tables"]["interactions"]["Row"];

// Props interface for the InteractionsPage component
interface InteractionsPageProps {
  contactId?: number;     // ID of the contact to show interactions for
  contactName?: string;   // Name of the contact for display purposes
}

export default function InteractionsPage({ contactId, contactName }: InteractionsPageProps) {
  // Get current authenticated user
  const { user } = useAuth();
  
  // Component state
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    interaction_date: "",
    interaction_type: "",
    summary: "",
  });

  // Load interactions when component mounts or contactId changes
  useEffect(() => {
    if (contactId) {
      loadInteractions();
    }
  }, [contactId]);

  /**
   * Load all interactions for the specified contact
   * Filters by contact_id and orders by date (most recent first)
   */
  const loadInteractions = async () => {
    if (!contactId) return;
    try {
      const data = await getInteractions(contactId);
      setInteractions(data);
    } catch (error) {
      console.error("Error loading interactions:", error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle form submission for creating a new interaction
   * 
   * @param e - Form submission event
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactId) return;

    try {
      const interactionData = {
        contact_id: contactId,
        interaction_date: formData.interaction_date,
        interaction_type: formData.interaction_type,
        summary: formData.summary || null,
      };

      await createInteraction(interactionData);
      await loadInteractions();
      setShowForm(false);
      setFormData({
        interaction_date: "",
        interaction_type: "",
        summary: "",
      });
    } catch (error) {
      console.error("Error creating interaction:", error);
    }
  };

  // Show loading state while fetching interactions
  if (loading) {
    return (
      <div className="p-8">Loading interactions...</div>
    );
  }

  return (
    <div className="p-8">
      {/* Page header with contact context */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">
            Interactions {contactName && `- ${contactName}`}
          </h1>
          <p className="text-gray-600 mt-1">
            Track all your touchpoints with this contact
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Add Interaction
        </button>
      </div>

      {/* Add interaction modal form */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-xl font-bold mb-4">Add Interaction</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Interaction date and time - required field */}
              <div>
                <label className="block text-sm font-medium mb-1">Date & Time *</label>
                <input
                  type="datetime-local"
                  required
                  value={formData.interaction_date}
                  onChange={(e) => setFormData({ ...formData, interaction_date: e.target.value })}
                  className="w-full border rounded px-3 py-2"
                />
              </div>

              {/* Interaction type - required field */}
              <div>
                <label className="block text-sm font-medium mb-1">Interaction Type *</label>
                <select
                  required
                  value={formData.interaction_type}
                  onChange={(e) => setFormData({ ...formData, interaction_type: e.target.value })}
                  className="w-full border rounded px-3 py-2"
                >
                  <option value="">Select type...</option>
                  <option value="email">Email</option>
                  <option value="phone">Phone Call</option>
                  <option value="video">Video Call</option>
                  <option value="coffee">Coffee Chat</option>
                  <option value="lunch">Lunch/Dinner</option>
                  <option value="conference">Conference</option>
                  <option value="social">Social Media</option>
                  <option value="other">Other</option>
                </select>
              </div>

              {/* Interaction summary - optional */}
              <div>
                <label className="block text-sm font-medium mb-1">Summary</label>
                <textarea
                  value={formData.summary}
                  onChange={(e) => setFormData({ ...formData, summary: e.target.value })}
                  className="w-full border rounded px-3 py-2"
                  rows={4}
                  placeholder="What was discussed? Any key takeaways?"
                />
              </div>

              {/* Form action buttons */}
              <div className="flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 border rounded hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Interactions list */}
      <div className="space-y-4">
        {interactions.length === 0 ? (
          // Empty state when no interactions exist
          <div className="text-center py-12 bg-white rounded-lg shadow">
            <p className="text-gray-500">No interactions recorded yet</p>
            <button
              onClick={() => setShowForm(true)}
              className="mt-4 text-blue-600 hover:text-blue-800"
            >
              Add your first interaction
            </button>
          </div>
        ) : (
          // List of interactions ordered by date (most recent first)
          interactions.map((interaction) => (
            <div key={interaction.id} className="bg-white p-6 rounded-lg shadow">
              {/* Interaction header with basic info */}
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-semibold capitalize">
                    {interaction.interaction_type}
                  </h3>
                  <p className="text-gray-600">
                    {new Date(interaction.interaction_date).toLocaleString()}
                  </p>
                </div>
              </div>

              {/* Interaction summary */}
              {interaction.summary && (
                <div>
                  <p className="text-sm font-medium mb-1">Summary:</p>
                  <p className="text-gray-700 whitespace-pre-wrap">{interaction.summary}</p>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
