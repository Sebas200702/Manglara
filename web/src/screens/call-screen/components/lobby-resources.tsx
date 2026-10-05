import { useState } from "react";
import {
  BookOpen,
  ChevronRight,
  Compass,
  Globe,
  Info,
  TrendingUp,
  Users,
} from "lucide-react";
import { Logo } from "../../../components/brand/logo";

// Define modules data
export interface ModuleData {
  id: number;
  title: string;
  description: string;
  color: string;
  bgColor: string;
  borderColor: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const MODULES: ModuleData[] = [
  {
    id: 1,
    title: "Módulo 1: Cambio climático y problemas ambientales",
    description: "Comprende las causas del cambio climático y sus efectos en la vida cotidiana, el territorio y las comunidades.",
    color: "text-brand-600",
    bgColor: "bg-brand-50/50",
    borderColor: "border-brand-200",
    icon: Compass,
  },
  {
    id: 2,
    title: "Módulo 2: Sostenibilidad y economía circular",
    description: "Explora la reducción de residuos, la biodiversidad y la resiliencia de las comunidades.",
    color: "text-navy-600",
    bgColor: "bg-navy-50/50",
    borderColor: "border-navy-200",
    icon: Globe,
  },
  {
    id: 3,
    title: "Módulo 3: Vida ecológica cotidiana",
    description: "Relaciona alimentación, agua, energía, movilidad y consumo con decisiones sostenibles posibles.",
    color: "text-accent-500",
    bgColor: "bg-accent-50/50",
    borderColor: "border-accent-200",
    icon: Users,
  },
  {
    id: 4,
    title: "Módulo 4: Comunicación y acción comunitaria",
    description: "Aprende a comunicar ideas, crear campañas y participar en soluciones colectivas con enfoque de justicia climática.",
    color: "text-brand-500",
    bgColor: "bg-[#fcfdec]",
    borderColor: "border-brand-200",
    icon: BookOpen,
  },
  {
    id: 5,
    title: "Módulo 5: Innovación y empleos sostenibles",
    description: "Conoce opciones de empleo verde, emprendimiento y herramientas para construir un proyecto de vida sostenible.",
    color: "text-accent-600",
    bgColor: "bg-accent-50/30",
    borderColor: "border-accent-200",
    icon: TrendingUp,
  },
];

export function LobbyResources() {
  const [activeTab, setActiveTab] = useState<"modules" | "booklets">("modules");
  const [selectedModule, setSelectedModule] = useState<ModuleData | null>(null);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tabs */}
      <div className="flex border-b border-neutral-200 bg-neutral-50 p-1 rounded-xl mx-4 mt-2">
        <button
          type="button"
          onClick={() => setActiveTab("modules")}
          className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
            activeTab === "modules"
              ? "bg-white text-navy-600 shadow-sm"
              : "text-neutral-500 hover:text-neutral-800"
          }`}
        >
          Módulos del Currículo
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("booklets")}
          className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
            activeTab === "booklets"
              ? "bg-white text-navy-600 shadow-sm"
              : "text-neutral-500 hover:text-neutral-800"
          }`}
        >
          Cartillas del Programa
        </button>
      </div>

      {/* Tab Contents */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "modules" ? (
          <div className="space-y-4">
            <div className="p-3 bg-brand-50 border border-brand-100 rounded-xl flex gap-2.5 items-start">
              <Info className="size-4 text-brand-600 shrink-0 mt-0.5" />
              <p className="text-xs text-brand-800 leading-relaxed">
                El currículo <strong>Habilidades Verdes para la Vida</strong> se organiza en cinco módulos que conectan la sostenibilidad con la vida cotidiana.
              </p>
            </div>

            <div className="grid gap-3">
              {MODULES.map((mod) => {
                const Icon = mod.icon;
                return (
                  <button
                    key={mod.id}
                    type="button"
                    onClick={() => setSelectedModule(mod)}
                    className={`w-full text-left p-3.5 rounded-xl border transition-all hover:scale-[1.01] hover:shadow-md cursor-pointer ${mod.bgColor} ${mod.borderColor}`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex gap-3">
                        <span className={`p-2 rounded-lg bg-white shadow-xs ${mod.color}`}>
                          <Icon className="size-5" />
                        </span>
                        <div>
                          <h3 className="text-xs font-bold text-neutral-900 leading-tight">
                            {mod.title}
                          </h3>
                        </div>
                      </div>
                      <ChevronRight className="size-4 text-neutral-400 self-center" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <p className="text-xs text-neutral-500 text-center leading-relaxed">
              Explora las portadas interactivas de las cartillas oficiales del programa.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 px-2">
              {/* Facilitador Book */}
              <div className="flex flex-col items-center gap-3">
                <span className="text-xs font-bold text-neutral-600">Cartilla del Facilitador</span>
                <div className="relative w-44 h-60 bg-white rounded-r-xl shadow-lg border border-neutral-200 overflow-hidden flex flex-col justify-between p-3.5 hover:rotate-1 hover:-translate-y-1 transition-all duration-300">
                  {/* Spine effect */}
                  <div className="absolute left-0 top-0 bottom-0 w-2.5 bg-gradient-to-r from-neutral-200 to-transparent opacity-80" />
                  
                  <div className="flex flex-col gap-1.5 z-10">
                    <span className="text-[6px] text-neutral-400 font-medium leading-none tracking-tight">
                      Cartilla del facilitador | Habilidades Verdes Ya
                    </span>
                    <Logo className="scale-65 origin-top-left -mt-1" />
                  </div>

                  {/* Aesthetic shapes of cover */}
                  <div className="absolute right-0 top-1/3 w-28 h-28 rounded-full bg-accent-100 opacity-60 translate-x-12 -translate-y-4" />
                  <div className="absolute right-12 top-1/2 w-8 h-8 rounded-full border border-brand-300 opacity-50" />

                  <div className="mt-auto z-10 flex flex-col gap-2">
                    <div>
                      <h4 className="text-xs font-black text-navy-600 leading-tight">
                        Hacia un mercado
                      </h4>
                      <h4 className="text-xs font-black text-navy-600 leading-tight">
                        laboral verde
                      </h4>
                    </div>
                    {/* Tiny logos container */}
                    <div className="flex gap-1 h-3 opacity-60 scale-75 origin-left">
                      <div className="w-4 bg-blue-700 h-full rounded-xs" />
                      <div className="w-8 bg-neutral-800 h-full rounded-xs" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Participante Book */}
              <div className="flex flex-col items-center gap-3">
                <span className="text-xs font-bold text-neutral-600">Cuaderno de Participante</span>
                <div className="relative w-44 h-60 bg-gradient-to-b from-brand-100 to-brand-50 rounded-r-xl shadow-lg border border-neutral-200 overflow-hidden flex flex-col justify-between p-3.5 hover:-rotate-1 hover:-translate-y-1 transition-all duration-300">
                  {/* Spine effect */}
                  <div className="absolute left-0 top-0 bottom-0 w-2.5 bg-gradient-to-r from-brand-300/30 to-transparent opacity-80" />

                  {/* Background illustration effect (hills, sun, turbines) */}
                  <div className="absolute inset-0 z-0">
                    {/* Hills */}
                    <div className="absolute bottom-0 right-0 left-0 h-28 bg-brand-200 rounded-t-full translate-y-8 scale-x-120" />
                    <div className="absolute bottom-0 right-0 left-0 h-16 bg-brand-300 rounded-t-full translate-y-4 scale-x-120 opacity-90" />
                    {/* Turbines lines */}
                    <div className="absolute right-6 bottom-16 w-0.5 h-10 bg-brand-400" />
                    <div className="absolute right-6 bottom-26 w-6 h-6 border border-dashed border-brand-400 rounded-full animate-spin [animation-duration:12s]" />
                    {/* Path */}
                    <div className="absolute bottom-0 left-10 w-8 h-16 bg-brand-50 rounded-full translate-y-6 rotate-12 skew-x-12" />
                    {/* Person silhouette walking */}
                    <div className="absolute bottom-8 left-12 w-2 h-6 bg-accent-600 rounded-full" />
                  </div>

                  <div className="z-10 flex flex-col gap-0.5">
                    <span className="text-[6px] text-neutral-600 font-bold leading-none tracking-tight">
                      Habilidades Verdes Ya
                    </span>
                    <div className="mt-2 text-left">
                      <span className="text-[8px] font-black text-navy-600 tracking-tight block uppercase">
                        MI CUADERNO
                      </span>
                      <span className="text-base font-extrabold text-brand-600 tracking-tight flex items-baseline gap-0.5 leading-none">
                        VERDE <span className="text-[8px] font-extrabold px-0.5 bg-brand-300 text-white rounded">YA</span>
                      </span>
                    </div>
                  </div>

                  <div className="z-10 mt-auto flex flex-col gap-1.5">
                    <span className="text-[8px] font-extrabold text-navy-600 leading-tight block">
                      Mi camino hacia un futuro sostenible
                    </span>
                    {/* Tiny logos container */}
                    <div className="flex gap-1 h-3 opacity-60 scale-75 origin-left">
                      <div className="w-4 bg-blue-700 h-full rounded-xs" />
                      <div className="w-8 bg-neutral-800 h-full rounded-xs" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Module Detail Modal */}
      {selectedModule && (
        <div className="absolute inset-0 bg-neutral-900/30 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-white rounded-2xl p-5 max-w-sm w-full shadow-2xl border border-neutral-100 relative">
            <span className={`inline-flex p-2.5 rounded-xl bg-neutral-50 mb-3.5 ${selectedModule.color}`}>
              {(() => {
                const Icon = selectedModule.icon;
                return <Icon className="size-6" />;
              })()}
            </span>
            
            <h3 className="text-sm font-extrabold text-neutral-900 mb-1">
              {selectedModule.title}
            </h3>
            
            <div className="text-xs text-neutral-700 leading-relaxed mb-5">
              <span className="block font-bold text-neutral-500 uppercase text-[9px] mb-1 tracking-wider">Sobre este módulo:</span>
              <p>{selectedModule.description}</p>
            </div>

            <button
              type="button"
              onClick={() => setSelectedModule(null)}
              className="w-full py-2.5 bg-navy-600 hover:bg-navy-700 text-white rounded-xl text-xs font-bold transition-all shadow-sm shadow-navy-600/10 cursor-pointer"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
