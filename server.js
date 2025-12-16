const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Supabase setup
const supabaseUrl = 'https://nixzwnfjglojemozlvmf.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5peHp3bmZqZ2xvamVtb3psdm1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc5NjMzMzMsImV4cCI6MjA3MzUzOTMzM30.qx8VUmL9EDlxtCNj4CF04Ld9xCFWDugNHhAmV0ixfuQ';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ModernTax Employment Verification API' });
});

// Employment verification endpoint
app.post('/api/v1/employment/verify', async (req, res) => {
  try {
    const { employee } = req.body;

    if (!employee) {
      return res.status(400).json({
        error: 'Missing "employee" field in request body',
        timestamp: new Date().toISOString(),
      });
    }

    const required = ['ssn', 'first_name', 'last_name', 'employer_name'];
    const missing = required.filter((field) => !employee[field]);

    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(', ')}`,
        required_fields: required,
        timestamp: new Date().toISOString(),
      });
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Log the request
    await supabase.from('api_requests').insert({
      customer_id: 'employer_com',
      endpoint: '/api/v1/employment/verify',
      method: 'POST',
      status_code: 200,
      response_time_ms: 0,
    }).catch(() => {});

    return res.status(200).json({
      request_id: requestId,
      status: 'success',
      message: 'Request received and processed',
      employee_info: {
        name: `${employee.first_name} ${employee.last_name}`,
        ssn_last_four: employee.ssn.slice(-4),
      },
      employer: employee.employer_name,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
