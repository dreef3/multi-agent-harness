import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";

export default function PlanApproval() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    navigate(`/projects/${id}/chat`, { replace: true });
  }, [id, navigate]);

  return null;
}
