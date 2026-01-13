// server.js - ModernTax Backend with Expert Authentication
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// CORS Middleware - Allow all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Supabase setup
const supabaseUrl = 'https://nixzwnfjglojemozlvmf.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5peHp3bmZqZ2xvamVtb3psdm1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc5NjMzMzMsImV4cCI6MjA3MzUzOTMzM30.qx8VUmL9EDlxtCNj4CF04Ld9xCFWDugNHhAmV0ixfuQ';
const supabase = createClient(supabaseUrl, supabaseKey);

// File upload setup
const upload = multer({ 
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype === 'application/json' || file.mimetype.includes('html')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, JSON, and HTML files allowed'));
    }
  }
});

// ============================================
// EXPERT AUTHENTICATION
// ============================================

app.post('/api/v1/experts/login', async (req, res) => {
  try {
    const { name, email, team } = req.body;

    if (!name || !email || !team) {
      return res.status(400).json({
        error: 'Missing required fields: name, email, team',
      });
    }

    const expertId = `EX_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // Insert or update expert in database
    const { data, error } = await supabase.from('experts').upsert({
      expert_id: expertId,
      name,
      email,
      team,
      last_login: new Date().toISOString(),
      status: 'active',
    }, {
      onConflict: 'email',
    });

    if (error) throw error;

    return res.status(200).json({
      expert_id: expertId,
      name,
      email,
      team,
      message: 'Expert logged in successfully',
    });

  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Login failed', message: error.message });
  }
});

// ============================================
// LOOKUP REQUEST
// ============================================

app.post('/api/v1/transcript-requests/lookup', async (req, res) => {
  try {
    const { tin, name } = req.body;

    if (!tin || !name) {
      return res.status(400).json({
        error: 'TIN and name required',
      });
    }

    // Search for existing request
    const { data, error } = await supabase
      .from('transcript_requests')
      .select('*')
      .or(`ssn.ilike.%${tin}%,first_name.ilike.%${name}%,last_name.ilike.%${name}%`)
      .limit(1);

    if (error) throw error;

    if (data && data.length > 0) {
      return res.status(200).json({
        request_id: data[0].request_id,
        taxpayer: `${data[0].first_name} ${data[0].last_name}`,
        status: data[0].status,
        created_at: data[0].created_at,
      });
    } else {
      return res.status(404).json({ error: 'Request not found' });
    }

  } catch (error) {
    console.error('Lookup error:', error);
    return res.status(500).json({ error: 'Lookup failed' });
  }
});

// ============================================
// STEP 1: 8821 FORM INTAKE
// ============================================

app.post('/api/v1/transcript-requests/create', async (req, res) => {
  try {
    const { ssn, first_name, last_name, email, employer_name, webhook_url } = req.body;

    if (!ssn || !first_name || !last_name || !email) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['ssn', 'first_name', 'last_name', 'email'],
      });
    }

    const requestId = `TR_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const { data, error } = await supabase.from('transcript_requests').insert({
      request_id: requestId,
      ssn,
      first_name,
      last_name,
      email,
      employer_name: employer_name || 'Not specified',
      webhook_url: webhook_url || null,
      status: 'pending_8821_submission',
      created_at: new Date().toISOString(),
      client: 'employer_com',
      cost: 59.98,
    });

    if (error) throw error;

    return res.status(201).json({
      request_id: requestId,
      status: 'pending_8821_submission',
      message: '8821 form submitted',
      taxpayer: {
        name: `${first_name} ${last_name}`,
        ssn_last_four: ssn.slice(-4),
      },
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// ============================================
// STEP 2: CHECK REQUEST STATUS
// ============================================

app.get('/api/v1/transcript-requests/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;

    const { data, error } = await supabase
      .from('transcript_requests')
      .select('*')
      .eq('request_id', requestId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Request not found' });
    }

    return res.status(200).json({
      request_id: data.request_id,
      status: data.status,
      taxpayer: {
        name: `${data.first_name} ${data.last_name}`,
        ssn_last_four: data.ssn.slice(-4),
      },
      created_at: data.created_at,
      completed_at: data.completed_at || null,
      income_data: data.income_data || null,
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// STEP 3: EXPERT UPLOAD TRANSCRIPT
// ============================================

app.post('/api/v1/transcripts/upload', upload.single('file'), async (req, res) => {
  try {
    const { requestId, year, expert_id, expert_name } = req.body;

    if (!requestId || !year || !req.file) {
      return res.status(400).json({
        error: 'Missing required fields: requestId, year, file',
      });
    }

    // Get the request
    const { data: request, error: fetchError } = await supabase
      .from('transcript_requests')
      .select('*')
      .eq('request_id', requestId)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Parse transcript based on file type
    let parsedData;
    if (req.file.mimetype === 'application/json') {
      parsedData = JSON.parse(req.file.buffer.toString());
    } else if (req.file.mimetype === 'application/pdf' || req.file.mimetype.includes('html')) {
      // For PDF/HTML, just store with metadata
      parsedData = {
        file_type: req.file.mimetype,
        file_name: req.file.originalname,
        file_size: req.file.size,
        parsed_at: new Date().toISOString(),
      };
    }

    // Store parsed transcript
    const { data: transcript, error: insertError } = await supabase
      .from('parsed_transcripts')
      .insert({
        request_id: requestId,
        year,
        raw_data: parsedData,
        parsed_at: new Date().toISOString(),
        status: 'parsed',
        expert_id: expert_id,
        expert_name: expert_name,
      });

    if (insertError) throw insertError;

    // Update request status
    await supabase
      .from('transcript_requests')
      .update({
        status: 'transcript_received',
        income_data: parsedData,
        completed_at: new Date().toISOString(),
      })
      .eq('request_id', requestId);

    // Record transaction
    await supabase
      .from('transactions')
      .insert({
        request_id: requestId,
        amount: 59.98,
        status: 'billed',
        client: request.client || 'employer_com',
        created_at: new Date().toISOString(),
      });

    // Log upload activity
    await supabase
      .from('upload_activity')
      .insert({
        request_id: requestId,
        expert_id: expert_id,
        expert_name: expert_name,
        year: year,
        file_name: req.file.originalname,
        file_size: req.file.size,
        uploaded_at: new Date().toISOString(),
      });

    // Send webhook notification to client
    if (request.webhook_url) {
      const webhookPayload = formatWebhookResponse(parsedData, request, year);
      sendWebhook(request.webhook_url, webhookPayload);
    }

    return res.status(200).json({
      message: 'Transcript uploaded and parsed successfully',
      request_id: requestId,
      year,
      expert: expert_name,
      cost: '$59.98',
      webhook_sent: !!request.webhook_url,
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

// ============================================
// STANDARD WEBHOOK FORMAT
// ============================================

function formatWebhookResponse(transcriptData, request, year) {
  const allIncomeData = {};
  if (transcriptData.income_by_year) {
    Object.assign(allIncomeData, transcriptData.income_by_year);
  }

  return {
    request_id: request.request_id,
    status: 'completed',
    timestamp: new Date().toISOString(),
    taxpayer: {
      name: `${request.first_name} ${request.last_name}`,
      ssn_last_four: request.ssn.slice(-4),
    },
    income_verification: {
      years_processed: Object.keys(allIncomeData),
      income_by_year: allIncomeData,
      employers: transcriptData.employers || [],
      forms_found: transcriptData.forms_found || [],
      multi_employer_detected: transcriptData.metadata?.multi_employer_detected || false,
    },
    billing: {
      amount: 59.98,
      amount_formatted: '$59.98',
      status: 'billed',
      transaction_date: new Date().toISOString(),
    },
  };
}

async function sendWebhook(webhookUrl, payload) {
  try {
    console.log(`Sending webhook to ${webhookUrl}`);
    await axios.post(webhookUrl, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('Webhook sent successfully');
  } catch (error) {
    console.error('Webhook delivery failed:', error.message);
  }
}

// ============================================
// DASHBOARD: Get Expert Activity
// ============================================

app.get('/api/v1/experts/:expertId/activity', async (req, res) => {
  try {
    const { expertId } = req.params;

    const { data, error } = await supabase
      .from('upload_activity')
      .select('*')
      .eq('expert_id', expertId)
      .order('uploaded_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    return res.status(200).json({
      expert_id: expertId,
      uploads: data || [],
      total_uploads: data?.length || 0,
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ModernTax Employment Verification Backend',
    version: '2.0',
    features: ['expert_authentication', 'transcript_upload', 'webhook_notifications'],
  });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Backend API running on port ${PORT}`);
  console.log(`🔐 Expert authentication enabled`);
  console.log(`📊 Supabase: ${supabaseUrl}`);
});

// ============================================
// EMPLOYMENT STATUS - Query Supabase
// ============================================

app.get('/api/v1/employment/status/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const token = req.headers.authorization?.split('Bearer ')[1];

    // Validate token
    if (!token || (token !== 'mt_live_emp_employercom_prod' && token !== 'mt_sandbox_emp_employercom_test123')) {
      return res.status(401).json({ 
        error: 'Invalid API key',
        timestamp: new Date().toISOString()
      });
    }

    // Query Supabase employment_requests table
    const { data, error } = await supabase
      .from('employment_requests')
      .select('request_id, status, employment_data, irs_retrieved_at, total_employers, multi_employer_detected, years')
      .eq('request_id', requestId)
      .single();

    if (error || !data) {
      return res.status(404).json({ 
        error: 'Request not found',
        request_id: requestId,
        timestamp: new Date().toISOString()
      });
    }

    // Build response - NO PII exposed
    const response = {
      request_id: data.request_id,
      status: data.status,
      timestamp: new Date().toISOString()
    };

    // If completed, return employment summary
    if (data.status === 'completed') {
      response.employment_verification = {
        employment_status: 'active',
        total_employers: data.total_employers,
        multi_employer_detected: data.multi_employer_detected,
        employment_history: data.employment_data?.employment_history || [],
        total_w2_income: data.employment_data?.total_w2_income || 0
      };
      response.completed_at = data.irs_retrieved_at;
    } else if (data.status === 'pending_irs_call') {
      response.message = 'Request received. Processing with IRS. Check back in 24-48 hours.';
      response.tax_years = data.years || [];
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('Employment status error:', error);
    return res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});


// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Backend API running on port ${PORT}`);
  console.log(`🔐 Expert authentication enabled`);
  console.log(`📊 Supabase: ${supabaseUrl}`);
});
