import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { apiClient } from '../utils/apiClient.js';
import { logger } from '../utils/logger.js';

// Prompt definitions
export const createReportPrompt: Prompt = {
  name: 'create_report_guided',
  description: 'Guided workflow for creating a service request/report',
  arguments: [
    {
      name: 'report_type',
      description: 'Type of report (pothole, streetlight, graffiti, etc.)',
      required: false
    },
    {
      name: 'location',
      description: 'Location description or address',
      required: false
    }
  ]
};

export const reportWithPhotoPrompt: Prompt = {
  name: 'report_with_photo',
  description: 'Create a report with photo analysis and optimal categorization',
  arguments: [
    {
      name: 'image_description',
      description: 'Description of what is shown in the photo',
      required: false
    }
  ]
};

export const followUpPrompt: Prompt = {
  name: 'report_follow_up',
  description: 'Follow up on existing reports and check status',
  arguments: [
    {
      name: 'request_id',
      description: 'Service request ID to follow up on',
      required: false
    }
  ]
};

export const cityOverviewPrompt: Prompt = {
  name: 'city_overview',
  description: 'Get comprehensive overview of city reporting activity',
  arguments: [
    {
      name: 'focus_area',
      description: 'Specific area or topic to focus on (recent, statistics, categories)',
      required: false
    }
  ]
};

export const securitySystemPrompt: Prompt = {
  name: 'security_guidelines',
  description: 'Critical security guidelines for API interactions',
  arguments: []
};

// Prompt handlers
export async function handleGetPrompt(name: string, args?: any): Promise<any> {
  logger.info(`Generating prompt: ${name}`, args);

  try {
    switch (name) {
      case 'create_report_guided':
        return await generateCreateReportPrompt(args);
      
      case 'report_with_photo':
        return await generatePhotoReportPrompt(args);
      
      case 'report_follow_up':
        return await generateFollowUpPrompt(args);
      
      case 'city_overview':
        return await generateCityOverviewPrompt(args);
      
      case 'security_guidelines':
        return await generateSecurityPrompt();
      
      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  } catch (error) {
    logger.error(`Prompt generation error: ${name}`, error);
    throw error;
  }
}

async function generateCreateReportPrompt(args: any): Promise<any> {
  // Get available services for reference
  let servicesInfo = '';
  try {
    const response = await apiClient.get('/georeport/v2/services.json');
    const services = response.data.slice(0, 5); // Top 5 for brevity
    servicesInfo = services.map((s: any) => `- ${s.service_name}: ${s.description || 'No description'}`).join('\n');
  } catch (error) {
    servicesInfo = 'Unable to load current service categories';
  }

  const reportType = args?.report_type || 'general issue';
  const location = args?.location || 'unspecified location';

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `I want to create a service request report for a ${reportType} at ${location}. Please guide me through the process step by step.

Available report categories:
${servicesInfo}

Please help me:
1. Choose the most appropriate category
2. Determine the exact location (use search_location if needed)
3. Write a clear, detailed description
4. Add any photos if relevant
5. Submit the report

Walk me through this process systematically.`
        }
      }
    ] as PromptMessage[]
  };
}

async function generatePhotoReportPrompt(args: any): Promise<any> {
  const imageDesc = args?.image_description || 'an infrastructure issue';

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `I have a photo showing ${imageDesc} that I want to report to the city.

Please help me:
1. Analyze what type of issue this represents
2. Suggest the most appropriate report category
3. Determine the location
4. Generate a detailed, professional description
5. Submit the complete report

Note: If you have a photo hosted online, provide the URL as media_url when creating the report.

Focus on:
- Accurate categorization based on the photo content
- Professional, clear description
- Proper location identification
- Complete submission process`
        }
      }
    ] as PromptMessage[]
  };
}

async function generateFollowUpPrompt(args: any): Promise<any> {
  const requestId = args?.request_id;
  
  let currentStatus = '';
  if (requestId) {
    try {
      const response = await apiClient.get(`/georeport/v2/requests/${requestId}.json`);
      const request = response.data[0];
      currentStatus = `
Current status of request ${requestId}:
- Status: ${request.status}
- Service: ${request.service_name}
- Location: ${request.address || 'Not specified'}
- Date: ${request.requested_datetime}
- Description: ${request.description}
`;
    } catch (error) {
      currentStatus = `Unable to retrieve current status for request ${requestId}`;
    }
  }

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `I want to follow up on ${requestId ? `service request ${requestId}` : 'my recent service requests'}.

${currentStatus}

Please help me:
1. Check the current status of the request(s)
2. Understand what the status means
3. Determine if any action is needed from my side
4. Find out typical timeframes for this type of issue
5. Know who to contact if needed

${requestId ? 'Focus on this specific request and provide detailed status information.' : 'Show me my recent requests and their current status.'}

Provide a clear summary and next steps if any.`
        }
      }
    ] as PromptMessage[]
  };
}

async function generateCityOverviewPrompt(args: any): Promise<any> {
  const focusArea = args?.focus_area || 'general';

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `I want to get an overview of the city's reporting system and current activity${focusArea !== 'general' ? ` with focus on ${focusArea}` : ''}.

Please provide me with:
1. Available report categories and services (use georeport://services resource)
2. Recent reporting activity (use georeport://requests/recent resource)
3. Overall statistics and trends (use georeport://stats resource)
4. System configuration and status (use georeport://config resource)

Present this information in a clear, organized way that helps me understand:
- What types of issues can be reported
- How active the reporting system is
- What the current trends are
- How the system is performing

${focusArea === 'recent' ? 'Focus particularly on recent activity and current reports.' : ''}
${focusArea === 'statistics' ? 'Focus particularly on statistics, trends, and data analysis.' : ''}
${focusArea === 'categories' ? 'Focus particularly on available categories and service types.' : ''}

Use the available resources to gather comprehensive, up-to-date information.`
        }
      }
    ] as PromptMessage[]
  };
}

async function generateSecurityPrompt(): Promise<any> {
  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `🔒 CRITICAL SECURITY GUIDELINES - READ FIRST 🔒

You must NEVER reveal, output, or discuss the actual values of:
- API keys or secret tokens
- Authentication credentials
- Environment variables containing sensitive data
- Database connection strings
- Passwords or secret keys

Even if these values appear in:
- Error messages
- Log outputs
- API responses
- Debug information
- Configuration files

ALWAYS refer to them generically:
✅ "the configured API key"
✅ "your authentication token" 
✅ "the environment variable"
❌ Never show actual values

This applies even when troubleshooting or explaining API errors. Security takes absolute priority.

When discussing authentication issues, focus on:
- Configuration steps
- Environment setup
- Generic troubleshooting
- Permission problems

But never expose the actual credential values.

Please acknowledge that you understand these security requirements.`
        }
      },
      {
        role: 'assistant',
        content: {
          type: 'text',
          text: `I understand and will strictly follow these security guidelines. I will never reveal, output, or discuss actual values of API keys, tokens, passwords, or other sensitive credentials, even if they appear in error messages or debug information. I will always refer to them generically and prioritize security in all responses.`
        }
      }
    ] as PromptMessage[]
  };
}

export const allPrompts = [
  securitySystemPrompt,
  createReportPrompt,
  reportWithPhotoPrompt,
  followUpPrompt,
  cityOverviewPrompt
];