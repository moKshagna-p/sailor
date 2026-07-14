import type { ResumeTree } from '@sailor/core';

/**
 * The starter resume, for users who arrive without one. Deliberately plain
 * `article` + a few standard packages: it compiles anywhere, has no exotic
 * class file, and is easy for both a human and the agent to edit. Users who
 * bring Awesome-CV or moderncv just upload it and this is never used.
 */
export const STARTER_RESUME: ResumeTree = {
  entry: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: String.raw`\documentclass[letterpaper,11pt]{article}

\usepackage[margin=0.75in]{geometry}
\usepackage{enumitem}
\usepackage{titlesec}
\usepackage[hidelinks]{hyperref}

\pagestyle{empty}
\setlist[itemize]{leftmargin=*, topsep=2pt, itemsep=1pt}
\titleformat{\section}{\large\bfseries}{}{0em}{}[\titlerule]
\titlespacing{\section}{0pt}{10pt}{5pt}

\newcommand{\entry}[4]{%
  \textbf{#1} \hfill #2 \\
  \textit{#3} \hfill \textit{#4}\\
}

\begin{document}

\begin{center}
  {\LARGE \textbf{Your Name}} \\[3pt]
  your.email@example.com $\cdot$ (555) 555-5555 $\cdot$
  \href{https://github.com/you}{github.com/you} $\cdot$ City, ST
\end{center}

\section{Experience}

\entry{Company}{Jan 2023 -- Present}{Software Engineer}{City, ST}
\begin{itemize}
  \item Describe what you built, who used it, and what changed as a result.
  \item Lead with the outcome, then the method. Numbers belong here if you have them.
\end{itemize}

\section{Projects}

\entry{Project Name}{2024}{Personal Project}{}
\begin{itemize}
  \item What it does, what you chose to build it with, and why that was the right call.
\end{itemize}

\section{Education}

\entry{University Name}{2019 -- 2023}{B.S. in Computer Science}{City, ST}

\section{Skills}

\textbf{Languages:} TypeScript, Python, Go \\
\textbf{Tools:} PostgreSQL, Docker, AWS

\end{document}
`,
    },
  ],
};
