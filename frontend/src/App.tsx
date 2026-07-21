import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import ProjectList from './pages/ProjectList';
import CreateProject from './pages/CreateProject';
import EditProject from './pages/EditProject';
import ProjectDetail from './pages/ProjectDetail';
import CrawlProgress from './pages/CrawlProgress';
import PagesViewer from './pages/PagesViewer';
import APIViewer from './pages/APIViewer';
import AnalysisViewer from './pages/AnalysisViewer';
import Reports from './pages/Reports';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="projects" element={<ProjectList />} />
          <Route path="projects/new" element={<CreateProject />} />
          <Route path="projects/:projectId/edit" element={<EditProject />} />
          <Route path="projects/:projectId" element={<ProjectDetail />} />
          <Route path="projects/:projectId/crawls/:sessionId" element={<CrawlProgress />} />
          <Route path="projects/:projectId/crawls/:sessionId/pages" element={<PagesViewer />} />
          <Route path="projects/:projectId/crawls/:sessionId/api" element={<APIViewer />} />
          <Route path="projects/:projectId/analysis" element={<AnalysisViewer />} />
          <Route path="projects/:projectId/reports" element={<Reports />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
