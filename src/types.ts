export interface KnowledgeGraphAgentSettings {
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  chatModel: string;
  embeddingModel: string;
  temperature: number;
  maxTokens: number;
  maxContextChunks: number;
  chunkSize: number;
  chunkOverlap: number;
  graphMaxNodes: number;
  graphShowOrphans: boolean;
}

export const DEFAULT_SETTINGS: KnowledgeGraphAgentSettings = {
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',
  chatModel: 'deepseek-chat',
  embeddingModel: 'deepseek-embed',
  temperature: 0.7,
  maxTokens: 4096,
  maxContextChunks: 10,
  chunkSize: 500,
  chunkOverlap: 50,
  graphMaxNodes: 200,
  graphShowOrphans: false,
};

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources?: SearchResult[];
}

export type IndexStatus = 'idle' | 'indexing' | 'ready' | 'error';

export interface IndexState {
  status: IndexStatus;
  message: string;
  chunkCount: number;
}

export interface GraphNode {
  id: string;
  label: string;
  path: string;
  links: number;
  relevanceScore?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SearchResult {
  path: string;
  title: string;
  chunk: string;
  score: number;
  sourceType?: 'pinned' | 'retrieved';
}

export interface ConversationContext {
  activeNotePath: string | null;
  selectedNotes: string[];
  searchResults: SearchResult[];
}
