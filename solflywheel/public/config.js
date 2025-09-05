// Set this to your deployed backend URL AFTER you deploy it.
window.BACKEND_BASE_URL = (typeof Netlify !== 'undefined' && Netlify && Netlify.env && Netlify.env.get) 
  ? Netlify.env.get('BACKEND_BASE_URL') 
  : 'http://localhost:8787';
